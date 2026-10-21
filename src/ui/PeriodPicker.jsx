import { PERIOD_PRESETS } from './period.js';
import { SelectField, TextField } from './components/Form.jsx';

/** Period selector with custom date inputs. */
export default function PeriodPicker({ period, custom, onChange }) {
  return (
    <div className="row" style={{ alignItems: 'flex-end' }}>
      <SelectField label="Period" value={period.preset} onChange={(v) => onChange({ preset: v, from: custom?.from || period.start, to: custom?.to || period.end })} options={PERIOD_PRESETS.map((p) => ({ value: p.id, label: p.label }))} />
      {period.preset === 'custom' && (
        <>
          <TextField label="From" type="date" value={custom?.from || period.start} onChange={(v) => onChange({ preset: 'custom', from: v, to: custom?.to || period.end })} />
          <TextField label="To" type="date" value={custom?.to || period.end} onChange={(v) => onChange({ preset: 'custom', from: custom?.from || period.start, to: v })} />
        </>
      )}
    </div>
  );
}
