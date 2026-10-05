using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Two mod folders, because the interesting question — does a FormID edit rewrite a FormLink
/// in a different mod folder's own repo — cannot be asked of one. No index anywhere in it.</summary>
public sealed class TwoModReferenceFixture : TestInstance, ITrackedPlugins
{
    public const string ReferencerPluginName = "Winner.esp";
    public const string TargetPluginName = "Base.esm";
    public const string TargetOrigin = "TargetMod";
    public const string ReferencerOrigin = "ReferencerMod";
    public const string TargetRaceEditorId = "TargetRace";
    public const string ReferencerNpcEditorId = "ReferencerNpc";

    public string TargetModFolder => FolderOf(TargetOrigin);
    public string ReferencerModFolder => FolderOf(ReferencerOrigin);

    public PluginAddress TargetPlugin { get; }
    public PluginAddress ReferencerPlugin { get; }

    /// <summary>Native to Base.esm and overridden unedited in Winner.esp, so the override case has a
    /// record to be asked about.</summary>
    public FormKey Npc { get; }

    public FormKey TargetRace { get; }
    public FormKey ReferencerNpc { get; }

    private TwoModReferenceFixture(bool trackReferencer)
    {
        var targetMod = new Fallout4Mod(ModKey.FromFileName(TargetPluginName), Fallout4Release.Fallout4);
        var race = targetMod.Races.AddNew(TargetRaceEditorId);
        var npc = targetMod.Npcs.AddNew("BaseNpc");
        (TargetRace, Npc) = (race.FormKey, npc.FormKey);
        TargetPlugin = Add(targetMod, TargetOrigin);

        var referencerMod = new Fallout4Mod(ModKey.FromFileName(ReferencerPluginName), Fallout4Release.Fallout4);
        referencerMod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(TargetPluginName) });
        referencerMod.Npcs.Set(targetMod.Npcs.First(n => n.FormKey == npc.FormKey).DeepCopy());
        var referencerNpc = referencerMod.Npcs.AddNew(ReferencerNpcEditorId);
        referencerNpc.Race.SetTo(race);
        ReferencerNpc = referencerNpc.FormKey;
        ReferencerPlugin = Add(referencerMod, ReferencerOrigin, trackReferencer);
        Seal();
    }

    public static TwoModReferenceFixture Create(bool trackReferencer) => new(trackReferencer);
}
