const mockSendJuryDeadlineReminderEmail = jest.fn();

jest.mock('../configs/firebase-init', () => ({
    db: global.__mockDb,
}));

jest.mock('../utils/Logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock('../services/EmailService', () => ({
    sendJuryDeadlineReminderEmail: mockSendJuryDeadlineReminderEmail,
}));

const makeDoc = (id, data) => ({
    id,
    data: () => data,
});

const RealDate = Date;

const makeDb = ({
    deadline,
    registrantCount = 22,
    scoredCount = registrantCount,
    juryDocId = 'auth-uid-pok',
    juryUid = 'stale-uid-pok',
    scoreJuryUserId = juryDocId,
}) => {
    const registrants = Array.from({ length: registrantCount }, (_, index) => ({
        id: `registrant-${index + 1}`,
        eventId: 'APCS2026',
        competitionCategory: 'Electone',
        paymentStatus: 'PAID',
    }));

    const scoreDocs = registrants.slice(0, scoredCount).map((registrant) => ({
        id: `${registrant.id}_${scoreJuryUserId}`,
        registrantId: registrant.id,
        juryUserId: scoreJuryUserId,
        score: 90,
    }));

    const getRows = (collectionName, filters) => {
        if (collectionName === 'users') {
            return [
                makeDoc(juryDocId, {
                    uid: juryUid,
                    role: 'jury',
                    name: 'POK CHEE HONG',
                    email: 'pok@example.com',
                    competitionCategory: 'Electone',
                }),
            ];
        }

        if (collectionName === 'Registrants2025') {
            return registrants.map((registrant) => makeDoc(registrant.id, registrant));
        }

        if (collectionName === 'JuryScores2025') {
            const juryUserIdFilter = filters.find((filter) => filter.field === 'juryUserId');
            return scoreDocs
                .filter((scoreDoc) => scoreDoc.juryUserId === juryUserIdFilter?.value)
                .map((scoreDoc) => makeDoc(scoreDoc.id, scoreDoc));
        }

        return [];
    };

    const makeQuery = (collectionName, filters = []) => ({
        where(field, operator, value) {
            return makeQuery(collectionName, [...filters, { field, operator, value }]);
        },
        async get() {
            const docs = getRows(collectionName, filters);
            return { empty: docs.length === 0, docs };
        },
    });

    return {
        collection(collectionName) {
            if (collectionName === 'systemSettings') {
                return {
                    doc() {
                        return {
                            async get() {
                                return {
                                    exists: true,
                                    data: () => ({
                                        currentEventId: 'APCS2026',
                                        juryDeadlines: {
                                            Electone: deadline.toISOString(),
                                        },
                                        juryDeadlineReminderSent: {},
                                    }),
                                };
                            },
                            set: jest.fn().mockResolvedValue(undefined),
                        };
                    },
                };
            }

            return makeQuery(collectionName);
        },
    };
};

const flushPromises = async () => {
    for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
    }
};

describe('JuryDeadlineReminder', () => {
    beforeEach(() => {
        jest.resetModules();
        mockSendJuryDeadlineReminderEmail.mockClear();
        jest.spyOn(global, 'setInterval').mockReturnValue(1);
        jest.spyOn(global, 'setTimeout').mockImplementation((callback) => {
            callback();
            return 1;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('does not email a fully scored jury when the users.uid field is stale', async () => {
        const now = new Date('2026-09-04T18:00:00.000Z');
        const deadline = new Date(now.getTime() + 23 * 60 * 60 * 1000);

        global.__mockDb = makeDb({
            deadline,
            juryDocId: 'auth-uid-pok',
            juryUid: 'stale-uid-pok',
            scoreJuryUserId: 'auth-uid-pok',
        });
        jest.spyOn(global, 'Date').mockImplementation((value) => (
            value ? new RealDate(value) : new RealDate(now)
        ));
        global.Date.now = jest.fn(() => now.getTime());

        const { startJuryDeadlineReminder } = require('./JuryDeadlineReminder');

        startJuryDeadlineReminder();
        await flushPromises();

        expect(mockSendJuryDeadlineReminderEmail).not.toHaveBeenCalled();
    });

    it('emails incomplete juries with the remaining assessment count', async () => {
        const now = new Date('2026-09-04T18:00:00.000Z');
        const deadline = new Date(now.getTime() + 23 * 60 * 60 * 1000);

        global.__mockDb = makeDb({
            deadline,
            registrantCount: 22,
            scoredCount: 20,
            juryDocId: 'auth-uid-pok',
            juryUid: 'auth-uid-pok',
            scoreJuryUserId: 'auth-uid-pok',
        });
        jest.spyOn(global, 'Date').mockImplementation((value) => (
            value ? new RealDate(value) : new RealDate(now)
        ));
        global.Date.now = jest.fn(() => now.getTime());

        const { startJuryDeadlineReminder } = require('./JuryDeadlineReminder');

        startJuryDeadlineReminder();
        await flushPromises();

        expect(mockSendJuryDeadlineReminderEmail).toHaveBeenCalledTimes(1);
        expect(mockSendJuryDeadlineReminderEmail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'pok@example.com',
            category: 'Electone',
            pendingCount: 2,
            totalCount: 22,
        }));
    });
});
