import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { 
  doc, 
  getDoc, 
  deleteDoc, 
  updateDoc, 
  collection, 
  getDocs, 
  query, 
  where, 
  writeBatch,
  Timestamp 
} from 'firebase/firestore';
import { UpdateProjectSchema } from '@/features/projects/model';
import { requireAdminApi } from '@/lib/admin-auth';

/**
 * API routes for individual project operations (GET, PUT, DELETE)
 */

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdminApi();
  if (denied) return denied;
  try {
    const { id: projectId } = await params;
    const projectDoc = await getDoc(doc(db, 'projects', projectId));
    
    if (!projectDoc.exists()) {
      return NextResponse.json(
        { success: false, error: 'Project not found' },
        { status: 404 }
      );
    }

    const projectData = projectDoc.data();
    return NextResponse.json({
      success: true,
      data: {
        id: projectDoc.id,
        ...projectData,
        eventDate: projectData.eventDate?.toDate?.()?.toISOString() || null,
        createdAt: projectData.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: projectData.updatedAt?.toDate?.()?.toISOString() || null,
      }
    });
  } catch (error) {
    console.error('Project fetch error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch project' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdminApi();
  if (denied) return denied;
  try {
    const { id: projectId } = await params;
    const body = await request.json();
    
    // Validate input data
    const validatedData = UpdateProjectSchema.parse(body);

    // Update project document
    const updateData = {
      ...validatedData,
      eventDate: validatedData.eventDate ? Timestamp.fromDate(new Date(validatedData.eventDate)) : null,
      updatedAt: Timestamp.now(),
    };

    await updateDoc(doc(db, 'projects', projectId), updateData);

    return NextResponse.json({
      success: true,
      data: { id: projectId, ...updateData }
    });
  } catch (error) {
    console.error('Project update error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update project' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/projects/[id]
 * 
 * Deletes a project and ALL associated data (codes, attendees, redemptions)
 * This provides the natural data cleanup functionality
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdminApi();
  if (denied) return denied;
  try {
    const { id: projectId } = await params;

    // Verify project exists
    const projectDoc = await getDoc(doc(db, 'projects', projectId));
    if (!projectDoc.exists()) {
      return NextResponse.json(
        { success: false, error: 'Project not found' },
        { status: 404 }
      );
    }

    // Get all related documents for deletion
    const [codesSnapshot, attendeesSnapshot, redemptionsSnapshot] = await Promise.all([
      getDocs(query(collection(db, 'codes'), where('projectId', '==', projectId))),
      getDocs(query(collection(db, 'attendees'), where('projectId', '==', projectId))),
      getDocs(query(collection(db, 'redemptions'), where('projectId', '==', projectId)))
    ]);

    const totalDocuments = codesSnapshot.size + attendeesSnapshot.size + redemptionsSnapshot.size + 1; // +1 for project doc

    // Use batch write for atomic deletion
    const batch = writeBatch(db);

    // Delete all codes
    codesSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Delete all attendees  
    attendeesSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Delete all redemptions
    redemptionsSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Delete the project itself
    batch.delete(doc(db, 'projects', projectId));

    // Execute all deletions atomically
    await batch.commit();

    return NextResponse.json({
      success: true,
      message: `Project and all associated data deleted successfully`,
      details: {
        projectId,
        deletedDocuments: totalDocuments,
        deletedCodes: codesSnapshot.size,
        deletedAttendees: attendeesSnapshot.size,
        deletedRedemptions: redemptionsSnapshot.size,
      }
    });
  } catch (error) {
    console.error('Project deletion error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete project' },
      { status: 500 }
    );
  }
}
