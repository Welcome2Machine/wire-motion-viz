import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export async function GET() {
  try {
    const filePath = path.resolve(process.cwd(), 'processed_intermediate_data.xlsx');
    const buf = await fs.readFile(filePath);
    return new NextResponse(buf, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  } catch (e) {
    return new NextResponse('Not Found', { status: 404 });
  }
}
