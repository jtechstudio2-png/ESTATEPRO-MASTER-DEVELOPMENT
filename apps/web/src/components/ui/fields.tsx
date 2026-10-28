'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import {
  Checkbox as AriaCheckbox,
  FieldError as AriaFieldError,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Radio,
  RadioGroup,
  Select,
  SelectValue,
  Text,
  TextArea,
  TextField as AriaTextField,
  Button as AriaButton,
} from 'react-aria-components';

import styles from './field.module.css';

interface BaseFieldProps {
  label: ReactNode;
  description?: ReactNode;
  /** Server or client error for this field; makes the field invalid (UI checklist §7). */
  error?: string | undefined;
  isRequired?: boolean;
  isDisabled?: boolean;
  name?: string;
}

function RequiredMark({ show }: { show: boolean | undefined }) {
  const t = useTranslations('form');
  return show ? <span className={styles.required}>({t('required')})</span> : null;
}

interface TextFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'tel' | 'url' | 'search' | 'date' | 'datetime-local' | 'time' | 'number';
  inputMode?: 'text' | 'decimal' | 'numeric' | 'email' | 'tel' | 'url' | 'search';
  multiline?: boolean;
  maxLength?: number;
  autoComplete?: string;
  /** Language and direction of the value (e.g. an Arabic title field). */
  lang?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
  placeholder?: string;
  step?: string;
  min?: string;
  max?: string;
  autoFocus?: boolean;
}

export function TextField({ label, description, error, isRequired, isDisabled, value, onChange, multiline, lang, dir, step, min, max, ...props }: TextFieldProps) {
  const inputProps = { lang, dir, step, min, max, placeholder: props.placeholder, autoComplete: props.autoComplete, autoFocus: props.autoFocus };
  return (
    <AriaTextField
      className={styles.field}
      value={value}
      onChange={onChange}
      isRequired={isRequired}
      isDisabled={isDisabled}
      isInvalid={error !== undefined}
      validationBehavior="aria"
      name={props.name}
      type={props.type}
      inputMode={props.inputMode}
      maxLength={props.maxLength}
    >
      <Label className={styles.label}>
        {label}
        <RequiredMark show={isRequired} />
      </Label>
      {multiline ? <TextArea className={`${styles.input} ${styles.textarea}`} {...inputProps} /> : <Input className={styles.input} {...inputProps} />}
      {description ? (
        <Text slot="description" className={styles.description}>
          {description}
        </Text>
      ) : null}
      <AriaFieldError className={styles.error}>{error}</AriaFieldError>
    </AriaTextField>
  );
}

export interface Option {
  id: string;
  label: string;
  isDisabled?: boolean;
}

interface SelectFieldProps extends BaseFieldProps {
  value: string | null;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
}

export function SelectField({ label, description, error, isRequired, isDisabled, value, onChange, options, placeholder, name }: SelectFieldProps) {
  return (
    <Select
      className={styles.field}
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      isRequired={isRequired}
      isDisabled={isDisabled}
      isInvalid={error !== undefined}
      validationBehavior="aria"
      name={name}
      placeholder={placeholder}
      disabledKeys={options.filter((option) => option.isDisabled).map((option) => option.id)}
    >
      <Label className={styles.label}>
        {label}
        <RequiredMark show={isRequired} />
      </Label>
      <AriaButton className={`${styles.select} ${styles.selectButton}`}>
        <SelectValue />
        <span aria-hidden="true">▾</span>
      </AriaButton>
      {description ? (
        <Text slot="description" className={styles.description}>
          {description}
        </Text>
      ) : null}
      <AriaFieldError className={styles.error}>{error}</AriaFieldError>
      <Popover className={styles.popover}>
        <ListBox className={styles.listbox}>
          {options.map((option) => (
            <ListBoxItem key={option.id} id={option.id} className={styles.option} textValue={option.label}>
              {option.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

export function Checkbox({ children, isSelected, onChange, isDisabled }: { children: ReactNode; isSelected: boolean; onChange: (value: boolean) => void; isDisabled?: boolean }) {
  return (
    <AriaCheckbox className={styles.checkbox} isSelected={isSelected} onChange={onChange} isDisabled={isDisabled}>
      <span className={styles.box} aria-hidden="true">
        {isSelected ? '✓' : ''}
      </span>
      {children}
    </AriaCheckbox>
  );
}

interface RadioGroupFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<Option & { description?: ReactNode }>;
}

export function RadioGroupField({ label, description, error, isRequired, isDisabled, value, onChange, options }: RadioGroupFieldProps) {
  return (
    <RadioGroup className={styles.radioGroup} value={value} onChange={onChange} isRequired={isRequired} isDisabled={isDisabled} isInvalid={error !== undefined} validationBehavior="aria">
      <Label className={styles.label}>
        {label}
        <RequiredMark show={isRequired} />
      </Label>
      {options.map((option) => (
        <Radio key={option.id} value={option.id} className={styles.radio} isDisabled={option.isDisabled}>
          <span className={styles.dot} aria-hidden="true" />
          <span>
            {option.label}
            {option.description ? <span className={styles.description}> — {option.description}</span> : null}
          </span>
        </Radio>
      ))}
      {description ? (
        <Text slot="description" className={styles.description}>
          {description}
        </Text>
      ) : null}
      <AriaFieldError className={styles.error}>{error}</AriaFieldError>
    </RadioGroup>
  );
}

/** Lays short related fields side by side; stacks on narrow screens. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className={styles.row}>{children}</div>;
}
