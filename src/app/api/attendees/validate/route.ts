import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { AttendeeValidationStepSchema } from '@/features/attendees/model';
import type { AttendeeValidationResponse } from '@/features/attendees/model';
import { getClientIp, rateLimit } from '@/lib/rate-limit';

/**
 * API route for validating attendee information during redemption
 */
export async function POST(request: NextRequest) {
  try {
    const limited = rateLimit(`validate:${getClientIp(request)}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!limited.ok) {
      return NextResponse.json(
        { success: false, error: 'Too many attempts. Please wait.' },
        { status: 429 }
      );
    }
    const body = await request.json();
    
    // Validate input data
    const validatedData = AttendeeValidationStepSchema.parse(body);
    
    // Handle backward compatibility: use eventId if projectId not provided
    const projectId = validatedData.projectId || validatedData.eventId || 'sample-event-1';
    
    if (validatedData.step === 'name') {
      return await validateNameStep(validatedData.name, projectId, validatedData);
    } else if (validatedData.step === 'email') {
      return await validateEmailStep(validatedData.name, validatedData.email!, projectId, validatedData);
    } else {
      return NextResponse.json(
        { 
          success: false, 
          error: 'Invalid validation step' 
        },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error('Attendee validation error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Validation failed' 
      },
      { status: 500 }
    );
  }
}

async function validateNameStep(name: string, projectId: string, validatedData?: any) {
  try {
    // Try project-based lookup first
    let attendeesSnapshot = await getDocs(
      query(
        collection(db, 'attendees'), 
        where('projectId', '==', projectId),
        where('name', '==', name.trim())
      )
    );
    
    // Only fall back to legacy query if we're specifically dealing with legacy eventId
    if (attendeesSnapshot.empty && 
        projectId === 'sample-event-1' && 
        !validatedData.projectId && 
        validatedData.eventId === 'sample-event-1') {
      attendeesSnapshot = await getDocs(
        query(
          collection(db, 'attendees'), 
          where('name', '==', name.trim())
        )
      );
    }

    if (attendeesSnapshot.empty) {
      const response: AttendeeValidationResponse = {
        isValid: false,
        hasAlreadyRedeemed: false,
        error: 'Name not found in attendee list. Please check the spelling or contact an organizer.'
      };
      
      return NextResponse.json({
        success: true,
        data: response
      });
    }

    const attendeeDoc = attendeesSnapshot.docs[0];
    const attendeeData = attendeeDoc.data();
    
    // Check if already redeemed
    const hasAlreadyRedeemed = attendeeData.hasRedeemedCode || false;
    
    const response: AttendeeValidationResponse = {
      isValid: true,
      attendeeId: attendeeDoc.id,
      expectedEmail: attendeeData.email,
      hasAlreadyRedeemed,
      error: hasAlreadyRedeemed ? 'You have already redeemed a code for this event.' : undefined
    };

    return NextResponse.json({
      success: true,
      data: response
    });
  } catch (error) {
    console.error('Name validation error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Name validation failed' 
      },
      { status: 500 }
    );
  }
}

async function validateEmailStep(name: string, email: string, projectId: string, validatedData?: any) {
  try {
    // Try project-based lookup first
    let attendeesSnapshot = await getDocs(
      query(
        collection(db, 'attendees'), 
        where('projectId', '==', projectId),
        where('name', '==', name.trim()),
        where('email', '==', email.toLowerCase().trim())
      )
    );
    
    // Only fall back to legacy query if we're specifically dealing with legacy eventId
    if (attendeesSnapshot.empty && 
        projectId === 'sample-event-1' && 
        validatedData && 
        !validatedData.projectId && 
        validatedData.eventId === 'sample-event-1') {
      attendeesSnapshot = await getDocs(
        query(
          collection(db, 'attendees'), 
          where('name', '==', name.trim()),
          where('email', '==', email.toLowerCase().trim())
        )
      );
    }

    if (attendeesSnapshot.empty) {
      const response: AttendeeValidationResponse = {
        isValid: false,
        hasAlreadyRedeemed: false,
        error: 'Email does not match the expected address for this name.'
      };
      
      return NextResponse.json({
        success: true,
        data: response
      });
    }

    const attendeeDoc = attendeesSnapshot.docs[0];
    const attendeeData = attendeeDoc.data();
    
    // Check if already redeemed
    const hasAlreadyRedeemed = attendeeData.hasRedeemedCode || false;
    
    const response: AttendeeValidationResponse = {
      isValid: true,
      attendeeId: attendeeDoc.id,
      hasAlreadyRedeemed,
      error: hasAlreadyRedeemed ? 'You have already redeemed a code for this event.' : undefined
    };

    return NextResponse.json({
      success: true,
      data: response
    });
  } catch (error) {
    console.error('Email validation error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Email validation failed' 
      },
      { status: 500 }
    );
  }
}