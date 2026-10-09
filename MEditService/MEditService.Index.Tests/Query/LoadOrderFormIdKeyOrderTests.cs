using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class LoadOrderFormIdKeyOrderTests
{
    private const string BasePlugin = "Base.esm";
    private const string LightPlugin = "Light.esl";
    private const string TopPlugin = "Top.esp";

    private static readonly FormKey ContainerKey = new(ModKey.FromFileName(BasePlugin), 0x800);

    private static readonly FormKey InBase = new(ModKey.FromFileName(BasePlugin), 0x900);
    private static readonly FormKey InLight = new(ModKey.FromFileName(LightPlugin), 0x801);
    private static readonly FormKey InTop = new(ModKey.FromFileName(TopPlugin), 0x800);
    private static readonly FormKey InUnloaded = new(ModKey.FromFileName("Unloaded.esp"), 0x700);
    private static readonly FormKey InOtherUnloaded = new(ModKey.FromFileName("Other.esp"), 0x600);
    private static readonly FormKey InLightBeyondItsSpace = new(ModKey.FromFileName(LightPlugin), 0x1001);

    private sealed record Placed(string Plugin, params Func<ContainerEntry>[] Items);

    private static CompareResult CompareOf(params Placed[] placed)
    {
        var builder = new PluginFixtureBuilder("medit-load-order-formid");
        foreach (var plugin in placed)
        {
            builder.WithPlugin(plugin.Plugin, mod => mod.Containers.Set(
                new Container(ContainerKey, Fallout4Release.Fallout4) { Items = [.. plugin.Items.Select(entry => entry())] }));
        }
        using var fixture = builder.Build();
        using var index = Indexes.Reconciled(fixture);
        return index.Records.GetCompare(ContainerKey.ToString())
            ?? throw new InvalidOperationException($"Expected {ContainerKey} to resolve to a compare result.");
    }

    private static IReadOnlyList<FieldDiff> ItemRows(Func<ContainerEntry>[] inLight, Func<ContainerEntry>[] inTop) =>
        CompareOf(new Placed(BasePlugin), new Placed(LightPlugin, inLight), new Placed(TopPlugin, inTop))
            .Diffs.Single(d => d.FieldName == "Items").Children ?? [];

    private static Func<ContainerEntry> Entry(FormKey item, FormKey? owner = null) => () => new()
    {
        Item = new ContainerItem { Item = new FormLink<IItemGetter>(item), Count = 1 },
        Data = owner is { } npc ? new ExtraData { Owner = new NpcOwner { Npc = new FormLink<INpcGetter>(npc) } } : null,
    };

    [Fact]
    public void AKeyedArraysRows_ReadInTheLoadOrderFormIdOrderOfTheirKeys_FullPluginsBeforeLightOnes()
    {
        var rows = ItemRows([], [Entry(InTop), Entry(InLight), Entry(InBase)]);

        Assert.Equal([InBase.ToString(), InTop.ToString(), InLight.ToString()], rows.Select(r => r.FieldName));
    }

    [Fact]
    public void KeysOfPluginsTheGameDoesNotLoad_ReadAfterEveryLoadedOne_InTheOrderOfTheirText()
    {
        var rows = ItemRows([], [Entry(InUnloaded), Entry(InTop), Entry(InOtherUnloaded), Entry(InBase)]);

        Assert.Equal(
            [InBase.ToString(), InTop.ToString(), InOtherUnloaded.ToString(), InUnloaded.ToString()], rows.Select(r => r.FieldName));
    }

    [Fact]
    public void EntriesAtOneKey_PairInTheLoadOrderFormIdOrderOfTheirOwners()
    {
        var ownedInBase = Entry(InBase, owner: InBase);
        var ownedInLight = Entry(InBase, owner: InLight);

        var rows = ItemRows([ownedInLight, ownedInBase], [ownedInBase]);

        var paired = rows.Single(r => r.Indexes?.ContainsKey(TopPlugin) == true);
        Assert.Equal(1, paired.Indexes?[LightPlugin]);
    }

    [Fact]
    public void AKeyBeyondItsPluginsSpace_HasNoLoadOrderFormId_AndNeverTakesAnotherRecordsPlace()
    {
        var rows = ItemRows([], [Entry(InLightBeyondItsSpace), Entry(InLight)]);

        Assert.Equal([InLight.ToString(), InLightBeyondItsSpace.ToString()], rows.Select(r => r.FieldName));
    }

    [Fact]
    public void EachColumnsLoadIndex_CountsAmongItsOwnKind_AFullOneInHex_ALightOneAfterFE()
    {
        var compare = CompareOf(new Placed(BasePlugin), new Placed(LightPlugin), new Placed(TopPlugin));

        Assert.Equal(["00", "FE:000", "01"], compare.Overrides.Select(o => o.LoadIndex));
    }
}
