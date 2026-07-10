import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { collection, addDoc, getDocs, query, where } from 'firebase/firestore';
import { parseCodesCSV, parseAttendeesCSV } from '@/lib/csv-parser';

/**
 * API route for uploading CSV files (codes and attendees)
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const type = formData.get('type') as 'codes' | 'attendees';
    const projectId = formData.get('projectId') as string;

    if (!file) {
      return NextResponse.json(
        { success: false, message: 'No file provided' },
        { status: 400 }
      );
    }

    if (!type || !['codes', 'attendees'].includes(type)) {
      return NextResponse.json(
        { success: false, message: 'Invalid upload type' },
        { status: 400 }
      );
    }

    if (!projectId) {
      return NextResponse.json(
        { success: false, message: 'Project ID is required' },
        { status: 400 }
      );
    }

    // Read and parse CSV file
    const fileContent = await file.text();
    
    if (type === 'codes') {
      const parsedCodes = parseCodesCSV(fileContent);
      if (parsedCodes.length === 0) {
        return NextResponse.json(
          { success: false, message: 'CSV file is empty or contains no valid codes' },
          { status: 400 }
        );
      }
      return await handleCodesUpload(parsedCodes, projectId);
    } else {
      const parsedAttendees = parseAttendeesCSV(fileContent);
      if (parsedAttendees.length === 0) {
        return NextResponse.json(
          { success: false, message: 'CSV file is empty or contains no valid attendees' },
          { status: 400 }
        );
      }
      return await handleAttendeesUpload(parsedAttendees, projectId);
    }
  } catch (error) {
    console.error('Upload API error:', error);
    return NextResponse.json(
      { success: false, message: 'Upload processing failed' },
      { status: 500 }
    );
  }
}

async function handleCodesUpload(data: Array<{
  code: string;
  cursorUrl: string;
  creator?: string;
  date?: string;
}>, projectId: string) {
  try {
    if (data.length === 0) {
      return NextResponse.json(
        { success: false, message: 'No valid codes found in CSV' },
        { status: 400 }
      );
    }

    // Check for existing codes in this project to avoid duplicates
    const existingCodesSnapshot = await getDocs(
      query(collection(db, 'codes'), where('projectId', '==', projectId))
    );
    const existingCodes = new Set(
      existingCodesSnapshot.docs.map(doc => doc.data().code)
    );

    // Filter out duplicates
    const newCodes = data.filter(codeData => !existingCodes.has(codeData.code));

    if (newCodes.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          message: 'All codes already exist in the database',
          details: { totalProcessed: data.length, duplicates: data.length }
        },
        { status: 400 }
      );
    }

    // Firestore rejects undefined field values — omit optional CSV columns
    const promises = newCodes.map((codeData) => {
      const record: Record<string, unknown> = {
        code: codeData.code,
        cursorUrl: codeData.cursorUrl,
        isRedeemed: false,
        projectId,
        createdAt: new Date(),
      };
      if (codeData.creator) record.creator = codeData.creator;
      if (codeData.date) record.date = codeData.date;
      return addDoc(collection(db, 'codes'), record);
    });

    await Promise.all(promises);

    return NextResponse.json({
      success: true,
      message: `Successfully uploaded ${newCodes.length} codes`,
      details: {
        totalProcessed: data.length,
        newCodes: newCodes.length,
        duplicatesSkipped: data.length - newCodes.length
      }
    });
  } catch (error) {
    console.error('Codes upload error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to process codes upload' },
      { status: 500 }
    );
  }
}

async function handleAttendeesUpload(data: Array<{
  name: string;
  email: string;
  firstName?: string;
  lastName?: string;
  checkedInAt?: string;
  approvalStatus?: string;
}>, projectId: string) {
  try {
    if (data.length === 0) {
      return NextResponse.json(
        { success: false, message: 'No valid attendee data found' },
        { status: 400 }
      );
    }

    // Check for existing attendees in this project to avoid duplicates
    const existingAttendeesSnapshot = await getDocs(
      query(collection(db, 'attendees'), where('projectId', '==', projectId))
    );
    const existingEmails = new Set(
      existingAttendeesSnapshot.docs.map(doc => doc.data().email)
    );

    // Filter out duplicates
    const newAttendees = data.filter(attendee => !existingEmails.has(attendee.email));

    if (newAttendees.length === 0) {
      return NextResponse.json(
        { 
          success: false, 
          message: 'All attendees already exist in the database',
          details: { totalProcessed: data.length, duplicates: data.length }
        },
        { status: 400 }
      );
    }

    const promises = newAttendees.map((attendee) => {
      const record: Record<string, unknown> = {
        name: attendee.name,
        email: attendee.email,
        hasRedeemedCode: false,
        projectId,
        createdAt: new Date(),
      };
      if (attendee.firstName) record.firstName = attendee.firstName;
      if (attendee.lastName) record.lastName = attendee.lastName;
      if (attendee.checkedInAt) record.checkedInAt = attendee.checkedInAt;
      if (attendee.approvalStatus) {
        record.approvalStatus = attendee.approvalStatus;
      }
      return addDoc(collection(db, 'attendees'), record);
    });

    await Promise.all(promises);

    return NextResponse.json({
      success: true,
      message: `Successfully uploaded ${newAttendees.length} attendees`,
      details: {
        totalProcessed: data.length,
        newAttendees: newAttendees.length,
        duplicatesSkipped: data.length - newAttendees.length
      }
    });
  } catch (error) {
    console.error('Attendees upload error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to process attendees upload' },
      { status: 500 }
    );
  }
}
