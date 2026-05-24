const { getVocalChoirDiscount, applyDiscount } = require('../discountUtils');

describe('discountUtils', () => {

    describe('getVocalChoirDiscount', () => {

        // --- Correct category and performance type ---

        it('returns 0% for less than 5 performers', () => {
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 1)).toBe(0);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 2)).toBe(0);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 3)).toBe(0);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 4)).toBe(0);
        });

        it('returns 5% for 5–10 performers', () => {
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 5)).toBe(0.05);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 7)).toBe(0.05);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 10)).toBe(0.05);
        });

        it('returns 15% for 11–20 performers', () => {
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 11)).toBe(0.15);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 15)).toBe(0.15);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 20)).toBe(0.15);
        });

        it('returns 20% for 21–30 performers', () => {
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 21)).toBe(0.20);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 25)).toBe(0.20);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 30)).toBe(0.20);
        });

        // --- Boundary tests ---

        it('boundary: 4 → 0%, 5 → 5%', () => {
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 4)).toBe(0);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 5)).toBe(0.05);
        });

        it('boundary: 10 → 5%, 11 → 15%', () => {
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 10)).toBe(0.05);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 11)).toBe(0.15);
        });

        it('boundary: 20 → 15%, 21 → 20%', () => {
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 20)).toBe(0.15);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 21)).toBe(0.20);
        });

        // --- Wrong category / performance type ---

        it('returns 0% for non-VocalChoir categories regardless of performer count', () => {
            expect(getVocalChoirDiscount('Piano', 'Ensemble', 10)).toBe(0);
            expect(getVocalChoirDiscount('Strings', 'Ensemble', 25)).toBe(0);
            expect(getVocalChoirDiscount('Guitar', 'Ensemble', 15)).toBe(0);
            expect(getVocalChoirDiscount('Guzheng', 'Ensemble', 30)).toBe(0);
        });

        it('returns 0% for VocalChoir Solo regardless of performer count', () => {
            expect(getVocalChoirDiscount('VocalChoir', 'Solo', 10)).toBe(0);
            expect(getVocalChoirDiscount('VocalChoir', 'Solo', 25)).toBe(0);
        });

        // --- Edge cases ---

        it('returns 0% for 0 or undefined performers', () => {
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', 0)).toBe(0);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', undefined)).toBe(0);
            expect(getVocalChoirDiscount('VocalChoir', 'Ensemble', null)).toBe(0);
        });
    });

    describe('applyDiscount', () => {

        it('applies 5% discount correctly (national IDR)', () => {
            // 5 performers × IDR 850,000 = 4,250,000
            const result = applyDiscount(4250000, 0.05);
            expect(result.finalAmount).toBe(4037500);
            expect(result.discountAmount).toBe(212500);
        });

        it('applies 15% discount correctly (national IDR)', () => {
            // 11 performers × IDR 850,000 = 9,350,000
            const result = applyDiscount(9350000, 0.15);
            expect(result.finalAmount).toBe(7947500);
            expect(result.discountAmount).toBe(1402500);
        });

        it('applies 20% discount correctly (national IDR)', () => {
            // 21 performers × IDR 850,000 = 17,850,000
            const result = applyDiscount(17850000, 0.20);
            expect(result.finalAmount).toBe(14280000);
            expect(result.discountAmount).toBe(3570000);
        });

        it('applies 5% discount correctly (international USD)', () => {
            // 5 performers × $85 = $425
            const result = applyDiscount(425, 0.05);
            expect(result.finalAmount).toBe(403.75);
            expect(result.discountAmount).toBe(21.25);
        });

        it('returns full amount when discount is 0', () => {
            const result = applyDiscount(850000, 0);
            expect(result.finalAmount).toBe(850000);
            expect(result.discountAmount).toBe(0);
        });
    });
});
