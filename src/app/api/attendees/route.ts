import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { requireAdminApi } from '@/lib/admin-auth';

/**
 * Public API route for fetching attendees during redemption flow
 * This is separate from the admin attendees API and handles the public redemption process
 */
export async function GET(request: NextRequest) {
  const denied = await requireAdminApi();
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    let projectId = searchParams.get('projectId');
    
    // For MVP compatibility: if no projectId provided, try to fetch legacy data first
    if (!projectId) {
      // First try to fetch from the old structure (for existing data without projectId)
      try {
        const legacyAttendeesSnapshot = await getDocs(collection(db, 'attendees'));
        const legacyAttendees = legacyAttendeesSnapshot.docs
          .filter(doc => !doc.data().projectId) // Only get truly legacy data (no projectId field)
          .map(doc => ({
            id: doc.id,
            name: doc.data().name,
            email: doc.data().email,
            hasRedeemed: doc.data().hasRedeemedCode || false,
          }))
          .filter(attendee => attendee.name && attendee.email);

        if (legacyAttendees.length > 0) {
          return NextResponse.json({ 
            success: true, 
            attendees: legacyAttendees 
          });
        }
      } catch {
        // If legacy fetch fails, continue with project-based approach
      }
      
      // If no legacy data found, use default projectId
      projectId = 'sample-event-1';
    }

    // Fetch attendees for the specific project
    const attendeesSnapshot = await getDocs(
      query(collection(db, 'attendees'), where('projectId', '==', projectId))
    );

    // Process attendees
    const attendees = attendeesSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        email: data.email,
        hasRedeemed: data.hasRedeemedCode || false,
      };
    }).filter(attendee => attendee.name && attendee.email);

    return NextResponse.json({ 
      success: true, 
      attendees 
    });
  } catch (error) {
    console.error('Public attendees API error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to fetch attendees',
        attendees: []
      },
      { status: 500 }
    );
  }
}
