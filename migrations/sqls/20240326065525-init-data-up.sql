INSERT INTO public.waste_status ("name") VALUES 
('Reception'),
('Composting'),
('Maturation'),
('Sieving'),
('Drying'),
('Storage');

INSERT INTO public.humidity_types ("level","name") VALUES 
('K', 'Dry'),
('L', 'Moist'),
('B', 'Wet');

INSERT INTO public.storage_areas ("name","width","length","height") VALUES 
('Storage A', 4, 4, 4),
('Storage B', 4, 4, 4),
('Storage C', 4, 4, 4);

INSERT INTO public.inbound_deliveries ("rejected_weight","organic_weight","inorganic_weight","hard_organic_weight","license_plate","note") VALUES 
(20,50,15,15,'AB 1234 XY', 'half organic weight'),
(10,60,20,10,'CD 2345 YZ', '-');

INSERT INTO public.waste ("inbound_delivery_id","simple_id") VALUES 
(1, '24032601'),
(1, '24032602'),
(1, '24032603'),
(2, '24032604'),
(2, '24032605');

INSERT INTO public.waste_logs ("next_checked_date","waste_id","humidity_types","curr_waste_status","next_waste_status","curr_storage_area_id","next_storage_area_id","weight","volume","temperature","note") VALUES 
(CURRENT_TIMESTAMP, 1, 1, 1, null, 1, null, 10, 4, 20, 'test'),
(CURRENT_TIMESTAMP, 1, 1, 1, null, 1, null, 10, 4, 20, 'test'),
(CURRENT_TIMESTAMP - INTERVAL '2 days', 1, 1, 1, null, 1, null, 10, 4, 20, 'test'),
(CURRENT_TIMESTAMP - INTERVAL '2 days', 2, 1, 1, null, 1, null, 10, 4, 20, 'test'),
(CURRENT_TIMESTAMP - INTERVAL '2 days', 2, 1, 1, null, 1, null, 10, 4, 20, 'test');
