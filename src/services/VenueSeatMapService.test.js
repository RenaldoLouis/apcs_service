const mockGet = jest.fn();
jest.mock('../configs/firebase-init', () => ({
    db: { collection: jest.fn(() => ({ doc: jest.fn(() => ({ get: mockGet })) })) },
}));

const { getVenueSeatMap, isFirebaseStorageUrl } = require('./VenueSeatMapService');

const storageUrl = 'https://firebasestorage.googleapis.com/v0/b/apcs-profile.appspot.com/o/venues%2FBehring.svg?alt=media&token=t';
const svgFile = { contentType: 'image/svg+xml', body: Buffer.from('<svg viewBox="0 0 1 1"></svg>') };
const eventWith = venues => ({ exists: true, data: () => ({ venues }) });

beforeEach(() => {
    mockGet.mockReset();
});

test('returns the SVG text of the venue image stored in the event', async () => {
    mockGet.mockResolvedValue(eventWith([{ id: 'V1', label: 'Behring Theatre', imageUrl: storageUrl }]));
    const fetchFile = jest.fn().mockResolvedValue(svgFile);
    await expect(getVenueSeatMap({ eventId: 'APCS2026', venueId: 'V1' }, { fetchFile }))
        .resolves.toEqual({ venueId: 'V1', venueLabel: 'Behring Theatre', svg: '<svg viewBox="0 0 1 1"></svg>' });
    expect(fetchFile).toHaveBeenCalledWith(storageUrl);
});

test('rejects invalid ids before reading Firestore', async () => {
    await expect(getVenueSeatMap({ eventId: 'APCS2026', venueId: 'a/b' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockGet).not.toHaveBeenCalled();
});

test('reports a missing event or venue', async () => {
    mockGet.mockResolvedValueOnce({ exists: false });
    await expect(getVenueSeatMap({ eventId: 'APCS2026', venueId: 'V1' })).rejects.toMatchObject({ statusCode: 404 });
    mockGet.mockResolvedValueOnce(eventWith([{ id: 'other' }]));
    await expect(getVenueSeatMap({ eventId: 'APCS2026', venueId: 'V1' })).rejects.toMatchObject({ statusCode: 404 });
});

test('never fetches an image URL outside Firebase Storage', async () => {
    mockGet.mockResolvedValue(eventWith([{ id: 'V1', imageUrl: 'https://example.com/map.svg' }]));
    const fetchFile = jest.fn();
    await expect(getVenueSeatMap({ eventId: 'APCS2026', venueId: 'V1' }, { fetchFile }))
        .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('no uploaded seat map') });
    expect(fetchFile).not.toHaveBeenCalled();
    expect(isFirebaseStorageUrl('http://firebasestorage.googleapis.com/v0/b/x/o/y')).toBe(false);
    expect(isFirebaseStorageUrl('https://firebasestorage.googleapis.com.evil.com/v0/b/x/o/y')).toBe(false);
});

test('rejects a non-SVG venue image such as an old JPEG', async () => {
    mockGet.mockResolvedValue(eventWith([{ id: 'V1', imageUrl: storageUrl }]));
    const fetchFile = jest.fn().mockResolvedValue({ contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8]) });
    await expect(getVenueSeatMap({ eventId: 'APCS2026', venueId: 'V1' }, { fetchFile }))
        .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('not an SVG') });
});

test('turns a download failure into a retryable gateway error', async () => {
    mockGet.mockResolvedValue(eventWith([{ id: 'V1', imageUrl: storageUrl }]));
    const fetchFile = jest.fn().mockRejectedValue(new Error('timeout'));
    await expect(getVenueSeatMap({ eventId: 'APCS2026', venueId: 'V1' }, { fetchFile }))
        .rejects.toMatchObject({ statusCode: 502 });
});
