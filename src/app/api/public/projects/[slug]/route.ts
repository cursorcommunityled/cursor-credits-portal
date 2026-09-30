import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';

/**
 * Public API route for fetching project information by slug
 * Used by public redemption pages
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;

    if (!slug) {
      return NextResponse.json(
        { success: false, error: 'Project slug is required' },
        { status: 400 }
      );
    }

    // Find project by slug
    const projectsRef = collection(db, 'projects');
    const projectQuery = query(
      projectsRef,
      where('slug', '==', slug),
      where('status', '==', 'active')
    );

    const projectSnapshot = await getDocs(projectQuery);

    if (projectSnapshot.empty) {
      return NextResponse.json(
        { success: false, error: 'Project not found or not active' },
        { status: 404 }
      );
    }

    const projectDoc = projectSnapshot.docs[0];
    const projectData = projectDoc.data();

    return NextResponse.json({
      success: true,
      data: {
        id: projectDoc.id,
        name: projectData.name,
        description: projectData.description || null,
        slug: projectData.slug,
        eventDate: projectData.eventDate?.toDate?.()?.toISOString() || null,
      }
    });
  } catch (error) {
    console.error('Public project fetch error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch project information' },
      { status: 500 }
    );
  }
}
