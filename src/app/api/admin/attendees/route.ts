import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { requireAdminApi } from '@/lib/admin-auth';

/**
 * API route for fetching all attendees with their redemption status for a specific project
 */
export async function GET(request: NextRequest) {
  const denied = await requireAdminApi();
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json(
        { error: 'Project ID is required' },
        { status: 400 }
      );
    }

    console.log(`[Attendees API] Fetching attendees for projectId: ${projectId}`);

    // Fetch attendees and redemptions for the specific project in parallel
    const [attendeesSnapshot, redemptionsSnapshot] = await Promise.all([
      getDocs(query(collection(db, 'attendees'), where('projectId', '==', projectId))),
      getDocs(query(collection(db, 'redemptions'), where('projectId', '==', projectId)))
    ]);

    console.log(`[Attendees API] Found ${attendeesSnapshot.size} attendees, ${redemptionsSnapshot.size} redemptions`);

    // Create a map of redemptions by attendee for quick lookup
    const redemptionMap = new Map();
    redemptionsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      // Handle both email field names for backward compatibility
      const email = data.attendeeEmail || data.email;
      const key = `${data.attendeeName}-${email}`.toLowerCase();
      redemptionMap.set(key, {
        redeemedAt: data.redeemedAt?.toDate?.()?.toISOString() || data.timestamp?.toDate?.()?.toISOString() || data.timestamp,
        codeUrl: data.codeUrl
      });
    });

    // Process attendees with redemption info
    const attendees = attendeesSnapshot.docs.map(doc => {
      const data = doc.data();
      const redemptionKey = `${data.name}-${data.email}`.toLowerCase();
      const redemption = redemptionMap.get(redemptionKey);
      
      return {
        id: doc.id,
        name: data.name,
        email: data.email,
        hasRedeemed: !!redemption,
        redeemedAt: redemption?.redeemedAt,
        codeUrl: redemption?.codeUrl
      };
    });

    // Sort by redemption status (pending first) then by name
    attendees.sort((a, b) => {
      if (a.hasRedeemed !== b.hasRedeemed) {
        return a.hasRedeemed ? 1 : -1; // pending first
      }
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ attendees });
  } catch (error) {
    console.error('Attendees API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch attendees' },
      { status: 500 }
    );
  }
}
