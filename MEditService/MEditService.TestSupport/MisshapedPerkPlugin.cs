using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.TestSupport;

/// <summary>Readable perks beside one whose entry 0 is clean and whose entry 1 is function 14 with EPFT 2, which Mutagen cannot read.</summary>
public static class MisshapedPerkPlugin
{
    public const string FileName = "Misshaped Perks.esp";
    public const string EditorId = "HarborMisshapedPerk";
    public const uint FormId = 0x000008EF;
    public static readonly string FormKey = $"{FormId & 0xFFFFFF:X6}:{FileName}";

    private static readonly string[] ReadableEditorIds = ["HarborReadablePerkOne", "HarborReadablePerkTwo"];

    public static GeneratedPlugin Plugin => new(FileName, MisshapedPerks.Misshape(Readable()));

    private static byte[] Readable()
    {
        var modKey = ModKey.FromFileName(FileName);
        var mod = new Fallout4Mod(modKey, Fallout4Release.Fallout4);
        foreach (var editorId in ReadableEditorIds)
            mod.Perks.AddNew(editorId).Effects.Add(CleanEntry());

        var misshaped = new Perk(new FormKey(modKey, FormId & 0xFFFFFF), Fallout4Release.Fallout4) { EditorID = EditorId };
        misshaped.Effects.Add(CleanEntry());
        misshaped.Effects.Add(MisshapedPerks.ActorValueEntry());
        mod.Perks.Add(misshaped);

        using var stream = new MemoryStream();
        mod.WriteToBinary(stream);
        return stream.ToArray();
    }

    private static PerkEntryPointModifyValue CleanEntry() => new()
    {
        Modification = PerkEntryPointModifyValue.ModificationType.Add,
    };
}
