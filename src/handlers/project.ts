import { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';

// Every query below runs through res.locals.db, the client acting as the calling user:
// Postgres row level security (can_access_project) decides what is visible/writable,
// so ownership can't be forgotten in a handler. See middleware/auth.ts.

const MAX_PROJECTS_PER_REQUEST = 50;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

// Columns a client may never set: ownership and bookkeeping are decided server-side.
const SERVER_MANAGED_COLUMNS = ['id', 'created_by', 'created_at'];

const projectsPayload = z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_PROJECTS_PER_REQUEST);

export const createProjects = async (req: Request, res: Response) => {
  const parsed = projectsPayload.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid projects payload' });
  }
  const userId = res.locals.user.id;
  const projects = parsed.data.map((project) => {
    const clean = { ...project };
    SERVER_MANAGED_COLUMNS.forEach((column) => delete clean[column]);
    return { ...clean, created_by: userId };
  });

  const { data, error } = await res.locals.db.from('projects').insert(projects).select('id');

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ message: 'Projects created successfully', data });
};

export const getProjects = async (_req: Request, res: Response) => {
  try {
    const userId = res.locals.user.id;

    // No created_by filter on purpose: RLS returns the user's own projects, the ones
    // shared with them (accounts.shared_project_ids) and, for admins, all projects.
    const { data: projects, error: errorProjects } = await res.locals.db
      .from('projects')
      .select(`
        *,
        energy_choices(id, strategy, choice)
      `);

    if (errorProjects) {
      return res.status(400).json({ error: errorProjects.message });
    }

    if (!projects || projects.length === 0) {
      return res.status(200).json([]);
    }

    const projectIds = projects.map((p: any) => p.id);

    const { data: dpeData, error: errorDpe } = await res.locals.db
      .from('dpe')
      .select('id_project, *')
      .in('id_project', projectIds);

    if (errorDpe) {
      return res.status(400).json({ error: errorDpe.message });
    }

    const dpeByProjectId: Record<string, any> = {};
    (dpeData ?? []).forEach((d: any) => {
      dpeByProjectId[d.id_project] = d;
    });

    const combined = projects.map((project: any) => {
      const dpeRow = dpeByProjectId[project.id];
      const choiceRow = project.energy_choices;

      return {
        ...project,
        // owner = created it, shared = given through accounts.shared_project_ids,
        // admin = an admin looking at someone else's project
        access: project.created_by === userId ? 'owner' : res.locals.isAdmin ? 'admin' : 'shared',
        strategy: choiceRow?.strategy,
        energyMixChoice: choiceRow?.choice,
        dpe: dpeRow,
        stateOfPlay: project.description,
        costEstimation: choiceRow?.choice
          ? {
              withAid: choiceRow.choice.resteACharge,
              withoutAid: choiceRow.choice.coutTotal,
            }
          : undefined,
        targetedEnergyRating: choiceRow?.choice
          ? choiceRow.choice.etiquette
          : undefined,
        actualEnergyRating: undefined, // Plus d'energy table
        energy_choices: undefined, // On retire cette propriété de la réponse
      };
    });

    res.status(200).json(combined);
  } catch (error) {
    console.error('getProjects failed', error);
    res.status(500).json({ error: 'Server error' });
  }
};

export const findProject = async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const { data, error } = await res.locals.db
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .maybeSingle();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  if (!data) {
    return res.status(404).json({ message: 'Project not found' });
  }

  res.status(200).json(data);
};

// Fields a collaborator may edit. created_by is deliberately absent: only an admin can
// change a project's owner (enforced in the database too), and not through this route.
const UPDATABLE_FIELDS = [
  'id_bouquet',
  'id_design',
  'address',
  'state',
  'name',
  'firstName',
  'lastName',
  'contract_type',
  'features',
  'id_energy_choices',
  'initial_state',
] as const;

export const updateProject = async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const updateFields = Object.fromEntries(
    UPDATABLE_FIELDS
      .filter((field) => req.body?.[field] !== undefined)
      .map((field) => [field, req.body[field]])
  );

  if (Object.keys(updateFields).length === 0) {
    return res.status(400).json({ error: 'No updatable field provided' });
  }

  const { data, error } = await res.locals.db
    .from('projects')
    .update(updateFields)
    .eq('id', projectId)
    .select();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(200).json(data);
};

export const deleteProject = async (req: Request, res: Response) => {
  const { projectId } = req.params;

  // RLS only lets the owner (or an admin) delete: a collaborator's delete matches 0 rows.
  const { data, error } = await res.locals.db
    .from('projects')
    .delete()
    .eq('id', projectId)
    .select();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  if (!data || data.length === 0) {
    return res.status(403).json({ error: 'Only the owner of a project can delete it' });
  }

  res.status(200).json(data);
};

const upload = multer({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
export const uploadImage = [
  upload.single('image'),
  async (req: Request, res: Response) => {
    const { projectId, imageId } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      return res.status(415).json({ error: 'Unsupported image type' });
    }
    // imageId becomes part of a storage path: no separators or traversal.
    if (!/^[\w.\-]+$/.test(imageId) || imageId.includes('..')) {
      return res.status(400).json({ error: 'Invalid image id' });
    }

    const { data, error } = await res.locals.db.storage
      .from('project-images')
      .upload(`${projectId}/${imageId}`, file.buffer, {
        contentType: file.mimetype,
      });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json(data);
  }
];

export const getProjectImages = async (req: Request, res: Response) => {
  const { projectId } = req.params;

  const { data, error } = await res.locals.db.storage
    .from('project-images')
    .list(`${projectId}`);

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(200).json(data);
};

export const updateProjectImageFullPath = async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const { imageFullPath } = req.body;

  if (!imageFullPath || typeof imageFullPath !== 'string') {
    return res.status(400).json({ error: "Image URL is required" });
  }

  const { data, error } = await res.locals.db
    .from('projects')
    .update({ imageFullPath })
    .eq('id', projectId)
    .select();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.status(200).json({ message: "Project image URL updated successfully", data });
};
