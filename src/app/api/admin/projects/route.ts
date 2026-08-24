import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { 
  collection, 
  getDocs, 
  addDoc, 
  query, 
  where, 
  orderBy,
  Timestamp 
} from 'firebase/firestore';
import { CreateProjectSchema, generateProjectSlug } from '@/features/projects/model';
import { requireAdminApi } from '@/lib/admin-auth';

/**
 * GET /api/admin/projects
 * 
 * Fetches all projects with their basic stats
 */
export async function GET() {
  const denied = await requireAdminApi();
  if (denied) return denied;
  try {
    // Fetch projects
    const projectsRef = collection(db, 'projects');
    const projectsSnapshot = await getDocs(
      query(projectsRef, orderBy('createdAt', 'desc'))
    );

    // Get project summaries with computed stats
    const projects = await Promise.all(
      projectsSnapshot.docs.map(async (doc) => {
        const projectData = doc.data();
        const projectId = doc.id;

        // Get counts for each collection
        const [codesSnapshot, attendeesSnapshot, redemptionsSnapshot] = await Promise.all([
          getDocs(query(collection(db, 'codes'), where('projectId', '==', projectId))),
          getDocs(query(collection(db, 'attendees'), where('projectId', '==', projectId))),
          getDocs(query(collection(db, 'redemptions'), where('projectId', '==', projectId)))
        ]);

        return {
          id: projectId,
          name: projectData.name,
          description: projectData.description || null,
          slug: projectData.slug,
          status: projectData.status || 'active',
          eventDate: projectData.eventDate?.toDate?.()?.toISOString() || null,
          createdAt: projectData.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
          totalCodes: codesSnapshot.size,
          totalAttendees: attendeesSnapshot.size,
          totalRedemptions: redemptionsSnapshot.size,
        };
      })
    );

    return NextResponse.json({ 
      success: true, 
      data: { projects } 
    });
  } catch (error) {
    console.error('Projects fetch error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch projects' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/projects
 * 
 * Creates a new project
 */
export async function POST(request: NextRequest) {
  const denied = await requireAdminApi();
  if (denied) return denied;
  try {
    const body = await request.json();
    
    // Validate input data
    const validatedData = CreateProjectSchema.parse({
      ...body,
      eventDate: body.eventDate ? new Date(body.eventDate) : undefined
    });

    // Generate slug if not provided
    const slug = validatedData.slug || generateProjectSlug(validatedData.name);

    // Check for slug uniqueness
    const existingProjectQuery = query(
      collection(db, 'projects'),
      where('slug', '==', slug)
    );
    const existingProjectSnapshot = await getDocs(existingProjectQuery);

    if (!existingProjectSnapshot.empty) {
      return NextResponse.json(
        { 
          success: false, 
          error: 'A project with this slug already exists. Please choose a different name or slug.' 
        },
        { status: 400 }
      );
    }

    // Create project document
    const now = Timestamp.now();
    const projectData = {
      name: validatedData.name,
      description: validatedData.description || '',
      slug,
      status: validatedData.status || 'active',
      eventDate: validatedData.eventDate ? Timestamp.fromDate(validatedData.eventDate) : null,
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await addDoc(collection(db, 'projects'), projectData);

    return NextResponse.json({
      success: true,
      data: {
        id: docRef.id,
        ...projectData,
        eventDate: projectData.eventDate?.toDate?.()?.toISOString() || null,
        createdAt: projectData.createdAt.toDate().toISOString(),
        updatedAt: projectData.updatedAt.toDate().toISOString(),
      }
    });
  } catch (error) {
    console.error('Project creation error:', error);
    
    if (error instanceof Error && error.name === 'ZodError') {
      return NextResponse.json(
        { success: false, error: 'Invalid project data provided' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { success: false, error: 'Failed to create project' },
      { status: 500 }
    );
  }
}
