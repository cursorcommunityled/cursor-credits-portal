import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { requireAdminApi } from '@/lib/admin-auth';

/**
 * API route for fetching all codes with their redemption status for a specific project
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

    console.log(`[Codes API] Fetching codes for projectId: ${projectId}`);

    // Fetch codes and redemptions for the specific project in parallel
    const [codesSnapshot, redemptionsSnapshot] = await Promise.all([
      getDocs(query(collection(db, 'codes'), where('projectId', '==', projectId))),
      getDocs(query(collection(db, 'redemptions'), where('projectId', '==', projectId)))
    ]);

    console.log(`[Codes API] Found ${codesSnapshot.size} codes, ${redemptionsSnapshot.size} redemptions`);

    // Create a map of redeemed codes for quick lookup
    const redemptionMap = new Map();
    redemptionsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      if (data.codeUrl) {
        redemptionMap.set(data.codeUrl, {
          redeemedBy: data.attendeeName,
          redeemedAt: data.redeemedAt?.toDate?.()?.toISOString() || data.timestamp?.toDate?.()?.toISOString() || data.timestamp,
          email: data.attendeeEmail || data.email
        });
      }
    });

    // Process codes with redemption info
    const codes = codesSnapshot.docs
      .map(doc => {
        const data = doc.data();
        // Handle both url and cursorUrl field names for backward compatibility
        const codeUrl = data.url || data.cursorUrl || '';
        const redemption = redemptionMap.get(codeUrl);
        
        return {
          id: doc.id,
          url: codeUrl,
          isUsed: !!redemption,
          redeemedBy: redemption?.redeemedBy,
          redeemedAt: redemption?.redeemedAt,
          email: redemption?.email
        };
      })
      .filter(code => code.url); // Filter out any codes without URLs

    // Sort by status (unused first) then by URL
    codes.sort((a, b) => {
      if (a.isUsed !== b.isUsed) {
        return a.isUsed ? 1 : -1; // unused first
      }
      // Safe comparison with null checks
      const urlA = a.url || '';
      const urlB = b.url || '';
      return urlA.localeCompare(urlB);
    });

    return NextResponse.json({ codes });
  } catch (error) {
    console.error('Codes API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch codes' },
      { status: 500 }
    );
  }
}
