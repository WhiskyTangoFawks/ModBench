using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Two copies of one plugin file in two mods, mod order resolving the name to the first, and a plugin of a
/// third mod linking a record of it. Each copy links its own record too (ADR-0012).</summary>
public sealed class SameNamedTargetFixture : TestInstance, ICompiledPlugins
{
    public const string TargetName = "Base.esm";
    public const string BaseNpcEditorId = "BaseNpc";
    public const string ReferencerNpcEditorId = "ReferencerNpc";

    public PluginAddress Winning { get; }
    public PluginAddress Losing { get; }
    public PluginAddress Referencer { get; }
    public FormKey Race { get; }

    public SameNamedTargetFixture()
    {
        var target = new Fallout4Mod(ModKey.FromFileName(TargetName), Fallout4Release.Fallout4);
        var race = target.Races.AddNew("TargetRace");
        target.Npcs.AddNew(BaseNpcEditorId).Race.SetTo(race);
        Race = race.FormKey;
        Winning = Add(target, "WinningMod");
        Losing = Add(target, "LosingMod", listing: Listing.Overridden);

        var referencer = new Fallout4Mod(ModKey.FromFileName("Referencer.esp"), Fallout4Release.Fallout4);
        referencer.ModHeader.MasterReferences.Add(new MasterReference { Master = target.ModKey });
        referencer.Npcs.AddNew(ReferencerNpcEditorId).Race.SetTo(race);
        Referencer = Add(referencer, "ReferencerMod");
        Seal();
    }
}
