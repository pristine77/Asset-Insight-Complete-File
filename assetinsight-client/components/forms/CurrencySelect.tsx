"use client";

import type { SelectHTMLAttributes } from "react";
import { reportCurrencyLabel, reportCurrencyOptions } from "@/lib/reportCurrency";

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, "value"> & {
  value: string;
  placeholder?: string;
};

export default function CurrencySelect({ value, placeholder = "Select currency", ...props }: Props) {
  return (
    <select {...props} value={value}>
      {!value ? <option value="" disabled>{placeholder}</option> : null}
      {reportCurrencyOptions(value).map(code => <option key={code} value={code}>{reportCurrencyLabel(code)}</option>)}
    </select>
  );
}
