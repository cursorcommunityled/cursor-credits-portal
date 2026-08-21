import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { collection, getDocs, query, orderBy, limit, where } from 'firebase/firestore';
import { requireAdminApi } from '@/lib/admin-auth';

/**
 * API route that provides dashboard statistics and recent activity for a specific project
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

    // Check if Firebase is properly initialized
    if (!db) {
      throw new Error('Firebase not initialized');
    }

    // Fetch all collections for the specific project with error handling
    let codesSnapshot, attendeesSnapshot, redemptionsSnapshot;
    
    try {
      [codesSnapshot, attendeesSnapshot, redemptionsSnapshot] = await Promise.all([
        getDocs(query(collection(db, 'codes'), where('projectId', '==', projectId))).catch(() => ({ docs: [], size: 0 })),
        getDocs(query(collection(db, 'attendees'), where('projectId', '==', projectId))).catch(() => ({ docs: [], size: 0 })),
        getDocs(query(
          collection(db, 'redemptions'), 
          where('projectId', '==', projectId)
        )).catch(() => ({ docs: [], size: 0 }))
      ]);
    } catch (firestoreError) {
      console.error('Firestore access error:', firestoreError);
      // Return empty dashboard if collections don't exist yet
      return NextResponse.json({
        totalCodes: 0,
        usedCodes: 0,
        totalAttendees: 0,
        totalRedemptions: 0,
        recentRedemptions: []
      });
    }

    // Calculate stats safely
    const codes = (codesSnapshot?.docs || []).map(doc => doc.data());
    
    // Calculate used codes by checking redemptions (more accurate than isUsed flag)
    const redeemedUrls = new Set(
      (redemptionsSnapshot?.docs || []).map(doc => doc.data().codeUrl).filter(Boolean)
    );
    const usedCodes = codes.filter(code => redeemedUrls.has(code.url)).length;
    
    const recentRedemptions = (redemptionsSnapshot?.docs || []).map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        attendeeName: data.attendeeName || 'Unknown',
        email: data.attendeeEmail || data.email || 'Unknown', // Try both field names
        timestamp: data.redeemedAt?.toDate?.()?.toISOString() || data.timestamp?.toDate?.()?.toISOString() || data.timestamp || new Date().toISOString(),
        codeUrl: data.codeUrl || 'N/A'
      };
    });

    const dashboardData = {
      totalCodes: codesSnapshot?.size || 0,
      usedCodes,
      totalAttendees: attendeesSnapshot?.size || 0,
      totalRedemptions: redemptionsSnapshot?.size || 0,
      recentRedemptions
    };

    return NextResponse.json(dashboardData);
  } catch (error) {
    console.error('Dashboard API error:', error);
    
    // Return more detailed error information
    return NextResponse.json(
      { 
        error: 'Failed to fetch dashboard data',
        details: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}
