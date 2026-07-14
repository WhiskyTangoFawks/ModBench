using System.Globalization;

namespace MEditService.Core.Edits;

// A plugin can be flagged ESL (light master) only if every FormID native to it falls within the
// ESL range 0x001–0xFFF. This finds the native FormKeys that violate that — a non-empty result
// means the plugin is ineligible (the remedy, compact-FormIDs, is a deferred script; issue #85).
internal static class EslEligibility
{
    // The ESL range is 0x001–0xFFF; only the upper bound needs checking. A native record can
    // never fall below 0x001 — Mutagen refuses to write a FormKey in the lower reserved range,
    // and 0x000 is the null FormKey — so the range reduces to "id > 0xFFF".
    private const uint MaxEslLocalId = 0xFFF;

    public static IReadOnlyList<string> OutOfRangeFormKeys(IEnumerable<string> nativeFormKeys)
    {
        var result = new List<string>();
        foreach (var fk in nativeFormKeys)
        {
            var colon = fk.IndexOf(':');
            if (colon <= 0) continue;
            if (uint.TryParse(fk.AsSpan(0, colon), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var id)
                && id > MaxEslLocalId)
            {
                result.Add(fk);
            }
        }
        return result;
    }
}
