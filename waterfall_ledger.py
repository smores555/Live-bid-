import json
import pandas as pd
import os

def build_waterfall_ledger():
    print("Starting displacement system...")

    # 1. LOAD ALL FILES
    try:
        with open('roster.json') as f: roster_data = json.load(f)
        with open('preferences.json') as f: prefs = json.load(f)
        with open('capacities.json') as f: capacities = json.load(f)
        with open('nobidpilots.json') as f: no_bid_raw = json.load(f)
        
        # Load retired pilots gracefully
        try:
            with open('retired_pilots.json') as f:
                ret_raw = json.load(f)
                retired = {int(p.get('sen', p.get('seniority', p))) for p in ret_raw if isinstance(p, dict) or isinstance(p, (int, str))}
        except FileNotFoundError:
            retired = set()

    except FileNotFoundError as e:
        print(f"ERROR: Cannot find the file '{e.filename}'. Make sure it is in the same folder as this script.")
        return

    # Normalize data structures (handles different JSON formats safely)
    no_bid = {int(p['sen']) if isinstance(p, dict) else int(p) for p in no_bid_raw}
    roster = list(roster_data.values()) if isinstance(roster_data, dict) else roster_data

    # 2. INITIALIZE THE LEDGER
    ledger = {}
    for cap in capacities:
        key = f"{cap['base']} {cap['seat']}".upper()
        ledger[key] = {
            "vacancies": int(cap.get('delta', 0)), 
            "proffer_queue": [], # Tracks WHO left this seat so the next pilot sees who proffered it
            "awarded_count": 0   # Tracks TOTAL pilots placed in this seat for the BPL rule
        }

    # Sort strictly by seniority (Crucial for the waterfall and BPL logic)
    sorted_roster = sorted([p for p in roster if 'sen' in p], key=lambda x: int(x['sen']))
    results = []

    # 3. PROCESS THE BIDS
    for pilot in sorted_roster:
        sen = int(pilot['sen'])
        
        if sen in retired:
            continue

        name = pilot.get('name', pilot.get('pil', 'UNKNOWN')).upper()
        curr = pilot.get('current', {})
        current_seat = f"{curr.get('base', '')} {curr.get('seat', '')}".strip().upper()

        # PHASE 1: EXEMPT PILOTS (No Bid or 320)
        is_320 = "320" in str(curr.values())
        if sen in no_bid or is_320:
            if current_seat in ledger:
                # They consume a spot, which increases the BPL count for juniors below them
                ledger[current_seat]["awarded_count"] += 1 
            
            note = "320 Fleet. Remain in current position." if is_320 else "Not allowed to bid. Remain in current position."
            results.append({
                "Sen": sen, "Name": name, "Position": f"737 {current_seat}", 
                "Pref": "-", "Status": "No Bid", "Note": note
            })
            continue

        # PHASE 2: ACTIVE BIDDING
        pilot_prefs = prefs.get(f"pil{sen}", prefs.get(str(sen), {})).get('preferences', [])
        awarded = False

        for idx, pref in enumerate(pilot_prefs):
            target_seat = str(pref.get('bid', '')).upper()
            pref_num = idx + 1
            bpl_limit = int(pref.get('bpl_min', 0))

            if target_seat not in ledger:
                continue
                
            # Check Bid Position List (BPL) Rule
            projected_spot = ledger[target_seat]["awarded_count"] + 1
            if bpl_limit > 0 and projected_spot > bpl_limit:
                results.append({
                    "Sen": sen, "Name": name, "Position": f"737 {target_seat}", 
                    "Pref": pref_num, "Status": "Denied", "Note": f"Hit Bid Position List limit ({bpl_limit})."
                })
                continue 
                
            # Check Vacancies 
            if target_seat == current_seat or ledger[target_seat]["vacancies"] > 0:
                if target_seat == current_seat:
                    note = "Remain in current position."
                else:
                    # THE DYNAMIC WATERFALL
                    ledger[target_seat]["vacancies"] -= 1 
                    
                    # Proffer Logic
                    if len(ledger[target_seat]["proffer_queue"]) > 0:
                        origin = ledger[target_seat]["proffer_queue"].pop(0) 
                        note = f"Open position available. Proffered from {origin['sen']} - {origin['name']}."
                    else:
                        note = "Awarded system vacancy."
                    
                    # Leave a proffer behind in the old seat for the next junior pilot
                    if current_seat in ledger:
                        ledger[current_seat]["vacancies"] += 1
                        ledger[current_seat]["proffer_queue"].append({'sen': sen, 'name': name})

                # Lock in the award for BPL tracking
                ledger[target_seat]["awarded_count"] += 1

                results.append({
                    "Sen": sen, "Name": name, "Position": f"737 {target_seat}", 
                    "Pref": pref_num, "Status": "Awarded", "Note": note
                })
                awarded = True
                break 

            else:
                # Denied due to no spots
                results.append({
                    "Sen": sen, "Name": name, "Position": f"737 {target_seat}", 
                    "Pref": pref_num, "Status": "Denied", "Note": "Requested position has no current vacancies."
                })

        # PHASE 3: FALLBACK
        if not awarded:
            if current_seat in ledger:
                ledger[current_seat]["awarded_count"] += 1
                results.append({
                    "Sen": sen, "Name": name, "Position": f"737 {current_seat}", 
                    "Pref": "-", "Status": "Awarded", "Note": "Remain in current position."
                })
            else:
                results.append({
                    "Sen": sen, "Name": name, "Position": "UNASSIGNED", 
                    "Pref": "-", "Status": "Denied", "Note": "No fallback available."
                })

    # 4. EXPORT TO CSV
    df = pd.DataFrame(results)
    output_filename = 'Corrected_Full_Ledger.csv'
    df.to_csv(output_filename, index=False)
    print(f"SUCCESS: System run complete. Results saved to '{output_filename}'.")

if __name__ == "__main__":
    build_waterfall_ledger()
