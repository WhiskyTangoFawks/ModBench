using Mutagen.Bethesda;

namespace MEditService.LoadOrder.Tests.Plugins;

// ADR-0013's participation and winner rules, on the immutable value the shared kernel holds. No
// DuckDB and no disk: a snapshot goes in, participation and winners come out.
public sealed class LoadOrderTests
{
    private const string Data = @"C:\Games\Fallout4\Data";
    private const string Instance = @"C:\MO2\Fallout4";

    private static RegisteredPlugin Registered(
        string name, string origin, int? slot, bool enabled = true, bool winning = true) =>
        new(name, origin, Path.Combine(@"C:\MO2\mods", origin, name), slot, enabled, winning);

    private static LoadOrderSnapshot Order(params RegisteredPlugin[] plugins) =>
        new(Data, Instance, GameRelease.Fallout4, plugins);

    [Fact]
    public void DisabledPlugin_DoesNotParticipate_AndIsStillRegistered()
    {
        var order = Order(Registered("A.esp", "ModA", slot: 0, enabled: false));

        Assert.False(order.Participates(new PluginAddress("A.esp", "ModA")));
        Assert.Empty(order.Participating);
        Assert.Equal(new Registration(0, Enabled: false, Winning: true), order.Registration(new PluginAddress("A.esp", "ModA")));
    }

    [Fact]
    public void OverriddenPlugin_DoesNotParticipate_AndWinningPluginNamesTheOther()
    {
        var winner = Registered("A.esp", "HighPriorityMod", slot: 0);
        var overridden = Registered("A.esp", "LowPriorityMod", slot: 0, winning: false);
        // The overridden plugin first, so snapshot order cannot stand in for the override order.
        var order = Order(overridden, winner);

        Assert.False(order.Participates(overridden.Key));
        Assert.True(order.Participates(winner.Key));
        Assert.Equal(winner, order.WinningPlugin("A.esp"));
        Assert.Equal([winner], order.Participating);
    }

    [Fact]
    public void PluginWithNoPluginsTxtLine_DoesNotParticipate()
    {
        var unlisted = Registered("Unlisted.esp", "ModU", slot: null);
        var order = Order(unlisted, Registered("Listed.esp", "ModL", slot: 0));

        Assert.False(order.Participates(unlisted.Key));
        Assert.Equal(unlisted, order.WinningPlugin("Unlisted.esp"));
        Assert.Equal(["Listed.esp"], order.Participating.Select(c => c.Name));
    }

    [Fact]
    public void Participating_IsInSlotOrder_NotSnapshotOrder()
    {
        var third = Registered("C.esp", "ModC", slot: 2);
        var first = Registered("A.esp", "ModA", slot: 0);
        var second = Registered("B.esp", "ModB", slot: 1);

        Assert.Equal([first, second, third], Order(third, first, second).Participating);
    }

    [Fact]
    public void EmptySnapshot_YieldsNoParticipants_AndKnowsNoPlugin()
    {
        var order = Order();

        Assert.Empty(order.Participating);
        Assert.Null(order.WinningPlugin("A.esp"));
        Assert.Null(order.Registration(new PluginAddress("A.esp", "ModA")));
        Assert.False(order.Participates(new PluginAddress("A.esp", "ModA")));
    }

    [Fact]
    public void ApplyingTheSameSnapshotTwice_KeepsTheValueHeld()
    {
        var holder = new LoadOrderHolder();
        var plugins = () => new[] { Registered("A.esp", "ModA", slot: 0), Registered("B.esp", "ModB", slot: 1, winning: false) };

        holder.Apply(Order(plugins()));
        var first = holder.Current;
        holder.Apply(Order(plugins()));

        Assert.Same(first, holder.Current);
    }

    [Fact]
    public void ApplyingADifferentSnapshot_ReplacesTheValue()
    {
        var holder = new LoadOrderHolder();
        Assert.Equal(LoadOrderSnapshot.Empty, holder.Current);

        holder.Apply(Order(Registered("A.esp", "ModA", slot: 0)));
        Assert.Equal(["A.esp"], holder.Current.Participating.Select(c => c.Name));

        holder.Apply(Order(Registered("A.esp", "ModA", slot: 0, enabled: false)));
        Assert.Empty(holder.Current.Participating);
    }

    [Fact]
    public void EqualValues_HashAlike_WhenTheirPathsDifferOnlyInCase()
    {
        var plugin = Registered("A.esp", "ModA", slot: 0);
        var lower = new LoadOrderSnapshot(Data.ToLowerInvariant(), Instance.ToLowerInvariant(), GameRelease.Fallout4, [plugin]);

        Assert.Equal(Order(plugin), lower);
        Assert.Equal(Order(plugin).GetHashCode(), lower.GetHashCode());
    }

    [Fact]
    public void TheCallersList_IsCopiedOnConstruction_SoTheValueCannotChangeBehindIt()
    {
        var plugins = new List<RegisteredPlugin> { Registered("A.esp", "ModA", slot: 0) };
        var order = new LoadOrderSnapshot(Data, Instance, GameRelease.Fallout4, plugins);

        plugins.Add(Registered("B.esp", "ModB", slot: 1));

        Assert.Equal(["A.esp"], order.Plugins.Select(c => c.Name));
    }

    // The entries are the whole of the snapshot: the path they carry names no directory that
    // exists, and the value resolves participation and the winner without one.
    [Fact]
    public void AValueBuiltFromEntriesAlone_WithNoDirectoryPresent_ParticipatesAndWins()
    {
        var absent = Path.Combine(Path.GetTempPath(), $"medit-no-such-data-{Guid.NewGuid():N}");
        LoadOrderEntry Entry(string origin, bool winning) =>
            new("A.esp", Path.Combine(absent, origin, "A.esp"), origin, Slot: 0, Enabled: true, winning);
        LoadOrderEntry[] entries = [Entry("LowPriorityMod", winning: false), Entry("HighPriorityMod", winning: true)];

        var order = new LoadOrderSnapshot(
            absent, null, GameRelease.Fallout4, [.. entries.Select(entry => RegisteredPlugin.Of(entry))]);

        Assert.False(Directory.Exists(absent));
        var winner = order.WinningPlugin("A.esp");
        Assert.NotNull(winner);
        Assert.Equal("HighPriorityMod", winner.Origin);
        Assert.Equal([new PluginAddress("A.esp", "HighPriorityMod")], order.Participating.Select(c => c.Key));
        Assert.False(order.Participates(new PluginAddress("A.esp", "LowPriorityMod")));
    }

    [Fact]
    public void APluginIsIdentifiedByOriginAndName_NotByNameAlone()
    {
        var order = Order(Registered("A.esp", "ModA", slot: 0), Registered("A.esp", "ModB", slot: 0, winning: false));

        var pluginA = order.Plugin(new PluginAddress("A.esp", "ModA"));
        Assert.NotNull(pluginA);
        Assert.Equal("ModA", pluginA.Origin);
        var pluginB = order.Plugin(new PluginAddress("A.esp", "ModB"));
        Assert.NotNull(pluginB);
        Assert.Equal("ModB", pluginB.Origin);
        Assert.Null(order.Plugin(new PluginAddress("A.esp", "ModC")));
    }

    // ADR-0012 invariant 2: the game's Data folder and Overwrite are origins, not mods — neither
    // one is a folder a repository can live in.
    [Fact]
    public void ModFolderOf_OnDataDirectoryOrOverwrite_IsNull()
    {
        var order = Order(
            Registered("Vanilla.esp", PluginOrigin.DataDirectory, slot: 0),
            Registered("Stray.esp", PluginOrigin.Overwrite, slot: 1));

        Assert.Null(order.ModFolderOf(new PluginAddress("Vanilla.esp", PluginOrigin.DataDirectory)));
        Assert.Null(order.ModFolderOf(new PluginAddress("Stray.esp", PluginOrigin.Overwrite)));
    }

    [Fact]
    public void ModFolderOf_OnAMod_IsThePluginsContainingFolder()
    {
        var plugin = Registered("A.esp", "ModA", slot: 0);
        var order = Order(plugin);

        Assert.Equal(Path.Combine(@"C:\MO2\mods", "ModA"), order.ModFolderOf(plugin.Key));
    }
}
