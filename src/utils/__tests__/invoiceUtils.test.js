const { buildInvoiceItem, buildInvoiceNotes, USD_TO_IDR_RATE } = require('../invoiceUtils');

describe('invoiceUtils', () => {

    describe('USD_TO_IDR_RATE', () => {
        it('should be 17800', () => {
            expect(USD_TO_IDR_RATE).toBe(17800);
        });
    });

    describe('buildInvoiceItem', () => {

        it('passes IDR price through unchanged', () => {
            const item = {
                name: 'Registration: Piano (Solo)',
                description: 'poco - 4 years old',
                price: 850000,
                discount: 0,
                currency: 'IDR'
            };

            const result = buildInvoiceItem(item);

            expect(result.price).toBe(850000);
            expect(result.discount).toBe(0);
            expect(result.description).toBe('poco - 4 years old');
        });

        it('converts USD price to IDR at the fixed rate', () => {
            const item = {
                name: 'Registration: VocalChoir (Ensemble)',
                description: 'Non_Professionals_B - older_than_four',
                price: 170,
                discount: 0,
                currency: 'USD'
            };

            const result = buildInvoiceItem(item);

            // $170 × 17,800 = Rp3,026,000
            expect(result.price).toBe(3026000);
            expect(result.description).toBe('Non_Professionals_B - older_than_four (Original: $170 USD)');
        });

        it('converts USD discount to IDR at the fixed rate', () => {
            const item = {
                name: 'Registration: VocalChoir (Ensemble)',
                description: 'Professionals_A - some_age',
                price: 425,
                discount: 21.25,
                currency: 'USD'
            };

            const result = buildInvoiceItem(item);

            // $425 × 17,800 = Rp7,565,000
            expect(result.price).toBe(7565000);
            // $21.25 × 17,800 = Rp378,250
            expect(result.discount).toBe(378250);
        });

        it('does not convert IDR discount', () => {
            const item = {
                name: 'Registration: VocalChoir (Ensemble)',
                description: 'test',
                price: 5000000,
                discount: 250000,
                currency: 'IDR'
            };

            const result = buildInvoiceItem(item);

            expect(result.price).toBe(5000000);
            expect(result.discount).toBe(250000);
        });

        it('handles zero discount for USD items', () => {
            const item = {
                name: 'Registration: Piano (Solo)',
                description: 'poco',
                price: 85,
                discount: 0,
                currency: 'USD'
            };

            const result = buildInvoiceItem(item);

            expect(result.price).toBe(1513000); // $85 × 17,800
            expect(result.discount).toBe(0);
        });

        it('uses default description when none provided', () => {
            const item = {
                name: 'Registration',
                price: 100,
                currency: 'USD'
            };

            const result = buildInvoiceItem(item);

            expect(result.description).toBe('APCS Registration (Original: $100 USD)');
        });

        it('rounds USD conversion to nearest integer', () => {
            const item = {
                name: 'Test',
                description: 'test',
                price: 85.5,
                discount: 4.275,
                currency: 'USD'
            };

            const result = buildInvoiceItem(item);

            // 85.5 × 17,800 = 1,521,900 (exact)
            expect(result.price).toBe(Math.round(85.5 * 17800));
            // 4.275 × 17,800 = 76,095 (exact)
            expect(result.discount).toBe(Math.round(4.275 * 17800));
        });

        // Regression test: the exact scenario from the user's invoice
        it('correctly calculates the invoice from the screenshot: 2 performers × $85 VocalChoir', () => {
            const item = {
                name: 'Registration: VocalChoir (Ensemble)',
                description: 'Non_Professionals_B - older_than_four',
                price: 170, // 2 × $85
                discount: 0,
                currency: 'USD'
            };

            const result = buildInvoiceItem(item);

            expect(result.price).toBe(3026000);
            expect(result.discount).toBe(0);
            expect(result.description).toContain('(Original: $170 USD)');
        });
    });

    describe('buildInvoiceNotes', () => {
        it('includes rate note for international invoices', () => {
            const notes = buildInvoiceNotes('25-05-2026', true);

            expect(notes).toContain('Please complete payment before 25-05-2026');
            expect(notes).toContain('17.800');
            expect(notes).toContain('USD');
        });

        it('omits rate note for national invoices', () => {
            const notes = buildInvoiceNotes('25-05-2026', false);

            expect(notes).toContain('Please complete payment before 25-05-2026');
            expect(notes).not.toContain('USD');
            expect(notes).not.toContain('17.800');
        });
    });
});
