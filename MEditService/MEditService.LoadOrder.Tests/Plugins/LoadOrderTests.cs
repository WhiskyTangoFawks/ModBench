using Mutagen.Bethesda;

namespace MEditService.LoadOrder.Tests.Plugins;

// ADR-0013 invariant 3 on the immutable value the shared kernel holds: Mod Management decides the
// active plugins, and the value carries that decision. No DuckDB and no disk.
public sealed class LoadOrderTests
{
    private const string Data = @"C:\Games\Fallout4\Data";
    private const string Instance = @"C:\MO2\Fallout4";

    private static RegisteredPlugin Registered(string name, string origin) =>
        new(name, origin, Path.Combine(@"C:\MO2\mods", origin, name));

    private static LoadOrderSnapshot Order(RegisteredPlugin[] plugins, params RegisteredPlugin[] active) =>
        new(Data, Instance, GameRelease.Fallout4, plugins, [.. active.Select(p => p.Key)]);

    [Fact]
    public void APluginTheSnapshotDoesNotListAsActive_IsNotActive_AndIsStillAPluginInTheInstance()
    {
        var plugin = Registered("A.esp", "ModA");

        var order = Order([plugin]);

        Assert.False(order.IsActive(plugin.Key));
        Assert.Null(order.LoadOrderIndex(plugin.Key));
        Assert.Empty(order.Active);
        Assert.Equal(plugin, order.Plugin(plugin.Key));
    }

    [Fact]
    public void TheActivePlugins_AreInTheOrderSent_AndEachPlaceIsItsLoadIndex()
    {
        var a = Registered("A.esp", "ModA");
        var b = Registered("B.esp", "ModB");
        var c = Registered("C.esp", "ModC");

        var order = Order([c, a, b], a, b, c);

        Assert.Equal([a, b, c], order.Active);
        Assert.Equal(0, order.LoadOrderIndex(a.Key));
        Assert.Equal(2, order.LoadOrderIndex(c.Key));
    }

    // ADR-0012 invariant 1: two plugins share a filename, and only the one listed is active.
    [Fact]
    public void OfTwoPluginsOfOneFilename_OnlyTheOneListedAsActive_IsActive()
    {
        var winner = Registered("A.esp", "HighPriorityMod");
        var overridden = Registered("A.esp", "LowPriorityMod");

        var order = Order([overridden, winner], winner);

        Assert.True(order.IsActive(winner.Key));
        Assert.False(order.IsActive(overridden.Key));
    }

    [Fact]
    public void AnActivePluginThatIsNoPluginInTheInstance_IsRefused()
    {
        Assert.Throws<ArgumentException>(() => Order([Registered("A.esp", "ModA")], Registered("B.esp", "ModB")));
    }

    // ADR-0012: the game loads one file per name.
    [Fact]
    public void TwoActivePluginsOfOneFilename_AreRefused_NamingBothOrigins()
    {
        RegisteredPlugin[] plugins = [Registered("A.esp", "ModA"), Registered("A.esp", "ModB")];

        var refusal = LoadOrderSnapshot.RefusalOf(plugins, [.. plugins.Select(p => p.Key)]);

        Assert.Contains("ModA, ModB", refusal, StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() => Order(plugins, plugins));
    }

    // ADR-0012 invariant 5 and editor.md's read-only status: a plugin the game does not load, and
    // the game folder's own plugins, are never edited.
    [Fact]
    public void IsImmutable_OnAnInactivePluginOrAGameFolderPlugin_AndOnlyThere()
    {
        var active = Registered("A.esp", "ModA");
        var inactive = Registered("B.esp", "ModB");
        var gameFolder = Registered("Fallout4.esm", PluginOrigin.DataDirectory);

        var order = Order([gameFolder, active, inactive], gameFolder, active);

        Assert.False(order.IsImmutable(active.Key));
        Assert.True(order.IsImmutable(inactive.Key));
        Assert.True(order.IsImmutable(gameFolder.Key));
    }

    [Fact]
    public void EmptySnapshot_HasNoActivePlugin_AndKnowsNoPlugin()
    {
        var order = Order([]);

        Assert.Empty(order.Active);
        Assert.Null(order.Plugin(new PluginAddress("A.esp", "ModA")));
        Assert.False(order.IsActive(new PluginAddress("A.esp", "ModA")));
    }

    [Fact]
    public void ApplyingTheSameSnapshotTwice_KeepsTheValueHeld()
    {
        var holder = new LoadOrderHolder();
        var a = Registered("A.esp", "ModA");
        var b = Registered("B.esp", "ModB");

        holder.Apply(Order([a, b], a));
        var first = holder.Current;
        holder.Apply(Order([a, b], a));

        Assert.Same(first, holder.Current);
    }

    [Fact]
    public void ASnapshotThatMovesOnlyTheActivePlugins_ReplacesTheValue()
    {
        var holder = new LoadOrderHolder();
        var a = Registered("A.esp", "ModA");
        var b = Registered("B.esp", "ModB");

        holder.Apply(Order([a, b], a, b));
        holder.Apply(Order([a, b], b, a));

        Assert.Equal([b, a], holder.Current.Active);
    }

    [Fact]
    public void EqualValues_HashAlike_WhenTheirPathsDifferOnlyInCase()
    {
        var plugin = Registered("A.esp", "ModA");
        var lower = new LoadOrderSnapshot(
            Data.ToLowerInvariant(), Instance.ToLowerInvariant(), GameRelease.Fallout4, [plugin], [plugin.Key]);

        Assert.Equal(Order([plugin], plugin), lower);
        Assert.Equal(Order([plugin], plugin).GetHashCode(), lower.GetHashCode());
    }

    [Fact]
    public void TheCallersLists_AreCopiedOnConstruction_SoTheValueCannotChangeBehindIt()
    {
        var a = Registered("A.esp", "ModA");
        var b = Registered("B.esp", "ModB");
        var plugins = new List<RegisteredPlugin> { a, b };
        var active = new List<PluginAddress> { a.Key };
        var order = new LoadOrderSnapshot(Data, Instance, GameRelease.Fallout4, plugins, active);

        plugins.Add(Registered("C.esp", "ModC"));
        active.Add(b.Key);

        Assert.Equal([a, b], order.Plugins);
        Assert.Equal([a], order.Active);
    }

    [Fact]
    public void APluginIsIdentifiedByOriginAndName_NotByNameAlone()
    {
        var order = Order([Registered("A.esp", "ModA"), Registered("A.esp", "ModB")]);

        Assert.Equal("ModA", order.Plugin(new PluginAddress("A.esp", "ModA"))?.Origin);
        Assert.Equal("ModB", order.Plugin(new PluginAddress("A.esp", "ModB"))?.Origin);
        Assert.Null(order.Plugin(new PluginAddress("A.esp", "ModC")));
    }

    // ADR-0012 invariant 2: the game's Data folder and Overwrite are origins, not mods — neither
    // one is a folder a repository can live in.
    [Fact]
    public void ModFolderOf_OnDataDirectoryOrOverwrite_IsNull()
    {
        var order = Order(
            [Registered("Vanilla.esp", PluginOrigin.DataDirectory), Registered("Stray.esp", PluginOrigin.Overwrite)]);

        Assert.Null(order.ModFolderOf(new PluginAddress("Vanilla.esp", PluginOrigin.DataDirectory)));
        Assert.Null(order.ModFolderOf(new PluginAddress("Stray.esp", PluginOrigin.Overwrite)));
    }

    [Fact]
    public void ModFolderOf_OnAMod_IsThePluginsContainingFolder()
    {
        var plugin = Registered("A.esp", "ModA");

        Assert.Equal(Path.Combine(@"C:\MO2\mods", "ModA"), Order([plugin]).ModFolderOf(plugin.Key));
    }
}
