'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AttendeeForSuggestion } from '../hooks/useAttendees';

interface AttendeeAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onAttendeeSelect: (attendee: AttendeeForSuggestion | null) => void;
  error?: string;
  disabled?: boolean;
  placeholder?: string;
  projectId?: string;
}

export function AttendeeAutocomplete({
  value,
  onChange,
  onAttendeeSelect,
  error,
  disabled = false,
  placeholder = "Enter attendee name...",
}: AttendeeAutocompleteProps) {
  return (
    <div className="relative">
      <Label htmlFor="attendee-name">Attendee Name</Label>
      <Input
        id="attendee-name"
        type="text"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          onAttendeeSelect(null);
        }}
        disabled={disabled}
        className={error ? 'border-red-500' : ''}
      />
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
