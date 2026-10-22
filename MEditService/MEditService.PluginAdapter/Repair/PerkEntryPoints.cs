namespace MEditService.PluginAdapter.Repair;

/// <summary>A perk's entry points: each PRKE of type 2, whose function is the next DATA's second byte
/// and whose parameter block runs until PRKF.</summary>
internal static class PerkEntryPoints
{
    // xEdit's names for a perk entry point's function, the same in every game it defines.
    private static readonly Dictionary<byte, string> FunctionNames = new()
    {
        [1] = "Set Value",
        [2] = "Add Value",
        [3] = "Multiply Value",
        [5] = "Add Actor Value Mult",
        [6] = "Absolute Value",
        [7] = "Negative Absolute Value",
        [9] = "Add Activate Choice",
        [10] = "Select Spell",
        [11] = "Select Text",
        [12] = "Set to Actor Value Mult",
        [13] = "Multiply Actor Value Mult",
        [14] = "Multiply 1 + Actor Value Mult",
        [15] = "Set Text",
    };

    /// <summary>One entry point, numbered among the perk's entry points, with the indexes of its
    /// parameter block's EPFT, EPFB and EPFD.</summary>
    internal sealed record EntryPoint(int Number, byte Function, byte? Epft, bool HasEpf3, IReadOnlyList<int> Parameters, int Epf3At)
    {
        internal string Name => $"entry point {Number} (function {Function}, {FunctionNames.GetValueOrDefault(Function, "Unknown")})";
    }

    internal static IEnumerable<EntryPoint> Of(InspectedRecord record)
    {
        if (record.Type != "PERK") yield break;
        var subrecords = record.Subrecords;
        var number = -1;
        var i = 0;
        while (i < subrecords.Count)
        {
            if (subrecords[i].Signature != "PRKE" || subrecords[i].Payload.Length < 1 || subrecords[i].Payload.Span[0] != 2)
            {
                i++;
                continue;
            }
            number++;

            byte? function = null;
            byte? epft = null;
            var hasEpf3 = false;
            var parameters = new List<int>();
            var epf3At = -1;
            var j = i + 1;
            for (; j < subrecords.Count && subrecords[j].Signature is not ("PRKF" or "PRKE"); j++)
            {
                var s = subrecords[j];
                if (s.Signature == "DATA" && function == null && s.Payload.Length >= 2) function = s.Payload.Span[1];
                if (s.Signature == "EPFT" && s.Payload.Length >= 1) epft = s.Payload.Span[0];
                if (s.Signature is "EPFT" or "EPFB" or "EPFD") parameters.Add(j);
                // The Creation Kit writes EPF3 after EPFT, EPFB and EPF2.
                if (s.Signature is "EPFT" or "EPFB" or "EPF2") epf3At = j + 1;
                if (s.Signature == "EPF3") hasEpf3 = true;
            }
            i = j;
            if (function is { } fn) yield return new EntryPoint(number, fn, epft, hasEpf3, parameters, epf3At);
        }
    }
}
