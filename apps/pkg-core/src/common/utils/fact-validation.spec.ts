import { FactType, FactCategory } from '@pkg/entities';
import { normalizeFactType, getFactCategory } from './fact-validation';

describe('normalizeFactType', () => {
  it('should return exact match for valid FactType values', () => {
    expect(normalizeFactType('position')).toBe(FactType.POSITION);
    expect(normalizeFactType('company')).toBe(FactType.COMPANY);
    expect(normalizeFactType('birthday')).toBe(FactType.BIRTHDAY);
    expect(normalizeFactType('skill')).toBe(FactType.SKILL);
    expect(normalizeFactType('education')).toBe(FactType.EDUCATION);
    expect(normalizeFactType('location')).toBe(FactType.LOCATION);
    expect(normalizeFactType('inn')).toBe(FactType.INN);
    expect(normalizeFactType('legal_address')).toBe(FactType.LEGAL_ADDRESS);
    expect(normalizeFactType('communication')).toBe(FactType.COMMUNICATION);
    expect(normalizeFactType('preference')).toBe(FactType.PREFERENCE);
  });

  it('should normalize case', () => {
    expect(normalizeFactType('POSITION')).toBe(FactType.POSITION);
    expect(normalizeFactType('Birthday')).toBe(FactType.BIRTHDAY);
    expect(normalizeFactType('COMPANY')).toBe(FactType.COMPANY);
    expect(normalizeFactType('Legal_Address')).toBe(FactType.LEGAL_ADDRESS);
  });

  it('should normalize hyphens and spaces to underscores', () => {
    expect(normalizeFactType('legal-address')).toBe(FactType.LEGAL_ADDRESS);
    expect(normalizeFactType('legal address')).toBe(FactType.LEGAL_ADDRESS);
  });

  it('should resolve known aliases', () => {
    expect(normalizeFactType('occupation')).toBe(FactType.POSITION);
    expect(normalizeFactType('job')).toBe(FactType.POSITION);
    expect(normalizeFactType('job_title')).toBe(FactType.POSITION);
    expect(normalizeFactType('expertise')).toBe(FactType.SPECIALIZATION);
    expect(normalizeFactType('technology')).toBe(FactType.SKILL);
    expect(normalizeFactType('tool')).toBe(FactType.SKILL);
    expect(normalizeFactType('certification')).toBe(FactType.EDUCATION);
    expect(normalizeFactType('address')).toBe(FactType.LOCATION);
    expect(normalizeFactType('actual_address')).toBe(FactType.LOCATION);
    expect(normalizeFactType('city')).toBe(FactType.LOCATION);
    expect(normalizeFactType('health_condition')).toBe(FactType.HEALTH);
    expect(normalizeFactType('timezone')).toBe(FactType.PREFERENCE);
    expect(normalizeFactType('nickname')).toBe(FactType.PREFERENCE);
    expect(normalizeFactType('communication_preference')).toBe(FactType.COMMUNICATION);
    expect(normalizeFactType('communication_style')).toBe(FactType.COMMUNICATION);
    expect(normalizeFactType('opinion')).toBe(FactType.PREFERENCE);
    expect(normalizeFactType('work_status')).toBe(FactType.STATUS);
  });

  it('should return null for unknown types', () => {
    expect(normalizeFactType('activity')).toBeNull();
    expect(normalizeFactType('transaction')).toBeNull();
    expect(normalizeFactType('daily_summary')).toBeNull();
    expect(normalizeFactType('phone_work')).toBeNull();
    expect(normalizeFactType('email_personal')).toBeNull();
    expect(normalizeFactType('bank_account')).toBeNull();
    expect(normalizeFactType('kpp')).toBeNull();
    expect(normalizeFactType('ogrn')).toBeNull();
    expect(normalizeFactType('random_string')).toBeNull();
    expect(normalizeFactType('')).toBeNull();
  });
});

describe('getFactCategory', () => {
  it('should return PROFESSIONAL for professional types', () => {
    expect(getFactCategory(FactType.POSITION)).toBe(FactCategory.PROFESSIONAL);
    expect(getFactCategory(FactType.COMPANY)).toBe(FactCategory.PROFESSIONAL);
    expect(getFactCategory(FactType.DEPARTMENT)).toBe(FactCategory.PROFESSIONAL);
    expect(getFactCategory(FactType.SPECIALIZATION)).toBe(FactCategory.PROFESSIONAL);
    expect(getFactCategory(FactType.SKILL)).toBe(FactCategory.PROFESSIONAL);
    expect(getFactCategory(FactType.EDUCATION)).toBe(FactCategory.PROFESSIONAL);
    expect(getFactCategory(FactType.ROLE)).toBe(FactCategory.PROFESSIONAL);
  });

  it('should return PERSONAL for personal types', () => {
    expect(getFactCategory(FactType.BIRTHDAY)).toBe(FactCategory.PERSONAL);
    expect(getFactCategory(FactType.LOCATION)).toBe(FactCategory.PERSONAL);
    expect(getFactCategory(FactType.FAMILY)).toBe(FactCategory.PERSONAL);
    expect(getFactCategory(FactType.HOBBY)).toBe(FactCategory.PERSONAL);
    expect(getFactCategory(FactType.LANGUAGE)).toBe(FactCategory.PERSONAL);
    expect(getFactCategory(FactType.HEALTH)).toBe(FactCategory.PERSONAL);
    expect(getFactCategory(FactType.STATUS)).toBe(FactCategory.PERSONAL);
  });

  it('should return PREFERENCES for preference types', () => {
    expect(getFactCategory(FactType.COMMUNICATION)).toBe(FactCategory.PREFERENCES);
    expect(getFactCategory(FactType.PREFERENCE)).toBe(FactCategory.PREFERENCES);
  });

  it('should return BUSINESS for business types', () => {
    expect(getFactCategory(FactType.INN)).toBe(FactCategory.BUSINESS);
    expect(getFactCategory(FactType.LEGAL_ADDRESS)).toBe(FactCategory.BUSINESS);
  });

  it('should have a mapping for every FactType', () => {
    for (const type of Object.values(FactType)) {
      expect(getFactCategory(type)).toBeDefined();
    }
  });
});
