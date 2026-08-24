/**
 * API route for code redemption
 * 
 * Handles the core business logic for validating attendee information
 * and assigning available codes from the database.
 */

import { NextRequest, NextResponse } from 'next/server';
import { collection, query, where, getDocs, runTransaction, doc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { AttendeeRedemptionSchema } from '@/features/attendees/model';
import type { ApiResponse } from '@/lib/types';
import { getClientIp, rateLimit } from '@/lib/rate-limit';

/**
 * POST /api/redeem
 * 
 * Redeems a code for a validated attendee.
 * Expects attendee to be pre-validated through the validation endpoint.
 */
export async function POST(request: NextRequest) {
  try {
    const limited = rateLimit(`redeem:${getClientIp(request)}`, {
      limit: 10,
      windowMs: 60_000,
    });
    if (!limited.ok) {
      return NextResponse.json(
        { success: false, error: 'Too many redemption attempts. Please wait.' },
        { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } }
      );
    }

    const body = await request.json();
    
    // Validate input data
    const validatedData = AttendeeRedemptionSchema.parse(body);
    
    // Handle backward compatibility: use eventId if projectId not provided
    const projectId = validatedData.projectId || validatedData.eventId || 'sample-event-1';
    
    // Final validation: check attendee exists and hasn't redeemed
    const attendeesRef = collection(db, 'attendees');
    let attendeeQuery = query(
      attendeesRef,
      where('projectId', '==', projectId),
      where('name', '==', validatedData.name.trim()),
      where('email', '==', validatedData.email.toLowerCase().trim())
    );
    
    let attendeeSnapshot = await getDocs(attendeeQuery);
    
    // Only fall back to legacy query if we're specifically dealing with legacy eventId
    if (attendeeSnapshot.empty && 
        projectId === 'sample-event-1' && 
        !validatedData.projectId && 
        validatedData.eventId === 'sample-event-1') {
      attendeeQuery = query(
        attendeesRef,
        where('name', '==', validatedData.name.trim()),
        where('email', '==', validatedData.email.toLowerCase().trim())
      );
      attendeeSnapshot = await getDocs(attendeeQuery);
    }
    
    if (attendeeSnapshot.empty) {
      const response: ApiResponse = {
        success: false,
        error: 'Attendee not found. Please validate your information first.',
        timestamp: new Date(),
      };
      return NextResponse.json(response, { status: 404 });
    }
    
    const attendeeDoc = attendeeSnapshot.docs[0];
    const attendeeData = attendeeDoc.data();
    
    // Check if already redeemed
    const redemptionsRef = collection(db, 'redemptions');
    let existingRedemptionQuery = query(
      redemptionsRef,
      where('projectId', '==', projectId),
      where('attendeeName', '==', validatedData.name.trim()),
      where('attendeeEmail', '==', validatedData.email.toLowerCase().trim())
    );
    
    let existingRedemptionSnapshot = await getDocs(existingRedemptionQuery);
    
    // Only fall back to legacy query if we're specifically dealing with legacy eventId
    // and there's no specific projectId in the request
    if (existingRedemptionSnapshot.empty && 
        projectId === 'sample-event-1' && 
        !validatedData.projectId && 
        validatedData.eventId === 'sample-event-1') {
      existingRedemptionQuery = query(
        redemptionsRef,
        where('attendeeName', '==', validatedData.name.trim()),
        where('attendeeEmail', '==', validatedData.email.toLowerCase().trim())
      );
      existingRedemptionSnapshot = await getDocs(existingRedemptionQuery);
    }
    
    if (!existingRedemptionSnapshot.empty) {
      const response: ApiResponse = {
        success: false,
        error: 'You have already redeemed a code. Each attendee can only redeem one code.',
        timestamp: new Date(),
      };
      return NextResponse.json(response, { status: 400 });
    }
    
    // Get available code
    const codesRef = collection(db, 'codes');
    let availableCodesQuery = query(
      codesRef,
      where('projectId', '==', projectId),
      where('isRedeemed', '==', false)
    );
    
    let availableCodesSnapshot = await getDocs(availableCodesQuery);
    
    // Only fall back to legacy codes if we're specifically dealing with legacy eventId
    if (availableCodesSnapshot.empty && 
        projectId === 'sample-event-1' && 
        !validatedData.projectId && 
        validatedData.eventId === 'sample-event-1') {
      availableCodesQuery = query(
        codesRef,
        where('isRedeemed', '==', false)
      );
      availableCodesSnapshot = await getDocs(availableCodesQuery);
    }
    
    console.log(`Found ${availableCodesSnapshot.size} available codes`);
    
    if (availableCodesSnapshot.empty) {
      // Check total codes for better error message
      const allCodesSnapshot = await getDocs(collection(db, 'codes'));
      const totalCodes = allCodesSnapshot.size;
      
      console.log(`Total codes in database: ${totalCodes}`);
      
      const errorMessage = totalCodes === 0 
        ? 'No codes have been uploaded yet. Please contact an administrator.'
        : 'All codes have been redeemed. Please contact an administrator for more codes.';
      
      const response: ApiResponse = {
        success: false,
        error: errorMessage,
        timestamp: new Date(),
      };
      return NextResponse.json(response, { status: 503 });
    }
    
    // Get the first available code
    const codeDoc = availableCodesSnapshot.docs[0];
    const codeData = codeDoc.data();
    
    // Use transaction to ensure atomicity
    const result = await runTransaction(db, async (transaction) => {
      const codeRef = doc(db, 'codes', codeDoc.id);
      const attendeeRef = doc(db, 'attendees', attendeeDoc.id);
      const freshCode = await transaction.get(codeRef);
      const freshAttendee = await transaction.get(attendeeRef);
      if (!freshCode.exists() || freshCode.data()?.isRedeemed) {
        throw new Error('That code is no longer available. Please retry.');
      }
      if (!freshAttendee.exists() || freshAttendee.data()?.hasRedeemedCode) {
        throw new Error('You have already redeemed a code. Each attendee can only redeem one code.');
      }
      const liveCode = freshCode.data() ?? codeData;

      transaction.update(codeRef, {
        isRedeemed: true,
        redeemedBy: attendeeDoc.id,
        redeemedAt: new Date(),
      });
      
      transaction.update(attendeeRef, {
        hasRedeemedCode: true,
        redeemedCodeId: codeDoc.id,
        redeemedAt: new Date(),
      });
      
      const redemptionRef = doc(collection(db, 'redemptions'));
      const redemptionData = {
        projectId: projectId,
        attendeeName: validatedData.name.trim(),
        attendeeEmail: validatedData.email.toLowerCase().trim(),
        attendeeId: attendeeDoc.id,
        codeId: codeDoc.id,
        codeValue: liveCode.code,
        codeUrl: liveCode.cursorUrl,
        redeemedAt: new Date(),
        timestamp: new Date(),
        ipAddress: request.headers.get('x-forwarded-for') || 
                   request.headers.get('x-real-ip') || 
                   'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
      };
      
      transaction.set(redemptionRef, redemptionData);
      
      return {
        code: liveCode.code,
        cursorUrl: liveCode.cursorUrl,
        attendeeId: attendeeDoc.id,
        redemptionId: redemptionRef.id,
      };
    });
    
    const response: ApiResponse = {
      success: true,
      data: {
        code: result.code,
        cursorUrl: result.cursorUrl,
        name: validatedData.name,
        email: validatedData.email,
        redemptionId: result.redemptionId,
      },
      timestamp: new Date(),
    };
    
    return NextResponse.json(response);
    
  } catch (error) {
    console.error('Redemption error:', error);
    
    const response: ApiResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Redemption failed',
      timestamp: new Date(),
    };
    
    return NextResponse.json(response, { status: 500 });
  }
}
