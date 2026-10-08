using Mutagen.Bethesda;

namespace MEditService.LoadOrder.Tests.Plugins;

public sealed class LoadOrderTests
{
    private const string Data = @"C:\Games\Fallout4\Data";
    private const string Instance = @"C:\MO2\Fallout4";

    private static RegisteredPlugin Registered(string name, string origin, int? line = null) =>
        new(name, origin, Path.Combine(@"C:\MO2\mods", origin, name), new PluginProvider.FromMod(origin, Path.Combine(@"C:\MO2\mods", origin)), line);

    private static LoadOrderSnapshot Order(RegisteredPlugin[] plugins, params RegisteredPlugin[] active) =>
        new(Data, Instance, GameRelease.Fallout4, plugins, [.. active.Select(p => p.Key)], []);

    private static LoadOrderSnapshot OrderLoadingWithNoLine(
        RegisteredPlugin[] plugins, RegisteredPlugin[] loadedWithNoLine, params RegisteredPlugin[] active) =>
        new(Data, Instance, GameRelease.Fallout4, plugins, [.. active.Select(p => p.Key)], [.. loadedWithNoLine.Select(p => p.Key)]);

    [Fact]
    public void APluginTheSnapshotDoesNotListAsActive_IsNotActive_AndIsStillAPluginInTheInstance()
    {
        var plugin = Registered("A.esp", "ModA");

        var order = Order([plugin]);

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

    [Fact]
    public void OfTwoPluginsOfOneFilename_OnlyTheOneListedAsActive_IsActive()
    {
        var winner = Registered("A.esp", "HighPriorityMod");
        var overridden = Registered("A.esp", "LowPriorityMod");

        var order = Order([overridden, winner], winner);

        Assert.NotNull(order.LoadOrderIndex(winner.Key));
        Assert.Null(order.LoadOrderIndex(overridden.Key));
    }

    [Fact]
    public void AnActivePluginThatIsNoPluginInTheInstance_IsRefused()
    {
        Assert.Throws<ArgumentException>(() => Order([Registered("A.esp", "ModA")], Registered("B.esp", "ModB")));
    }

    [Fact]
    public void TwoActivePluginsOfOneFilename_AreRefused_NamingBothOrigins_BecauseTheGameLoadsOneFilePerName()
    {
        RegisteredPlugin[] plugins = [Registered("A.esp", "ModA"), Registered("A.esp", "ModB")];

        var refusal = LoadOrderSnapshot.RefusalOf(plugins, [.. plugins.Select(p => p.Key)], []);

        Assert.Contains("ModA, ModB", refusal, StringComparison.Ordinal);
        Assert.Throws<ArgumentException>(() => Order(plugins, plugins));
    }

    [Fact]
    public void IsImmutable_OnlyOnAPluginTheGameProvides_ActiveOrNot()
    {
        var master = new RegisteredPlugin("Fallout4.esm", PluginOrigin.DataDirectory, Path.Combine(Data, "Fallout4.esm"), PluginProvider.Game, Line: null);
        var active = Registered("A.esp", "ModA");
        var inactive = Registered("B.esp", "ModB");

        var order = Order([master, active, inactive], master, active);

        Assert.True(order.IsImmutable(master.Key));
        Assert.False(order.IsImmutable(active.Key));
        Assert.False(order.IsImmutable(inactive.Key));
    }

    [Fact]
    public void OfTwoActivePlugins_TheOneWithTheLowerLoadIndex_LoadsBefore()
    {
        var a = Registered("A.esp", "ModA", line: 1);
        var b = Registered("B.esp", "ModB", line: 0);

        var order = Order([a, b], a, b);

        Assert.True(order.LoadsBefore(a.Key, b.Key));
        Assert.False(order.LoadsBefore(b.Key, a.Key));
    }

    [Fact]
    public void APluginThatIsNotActive_LoadsWhereItsLineFalls_AfterThePluginsLoadedWithNoLine()
    {
        var master = Registered("Fallout4.esm", "Masters");
        var early = Registered("Early.esp", "ModE", line: 0);
        var first = Registered("A.esp", "ModA", line: 1);
        var disabled = Registered("B.esp", "ModB", line: 2);
        var last = Registered("C.esp", "ModC", line: 3);

        var order = OrderLoadingWithNoLine([master, early, first, disabled, last], [master], master, first, last);

        Assert.True(order.LoadsBefore(master.Key, early.Key));
        Assert.True(order.LoadsBefore(early.Key, first.Key));
        Assert.True(order.LoadsBefore(first.Key, disabled.Key));
        Assert.True(order.LoadsBefore(disabled.Key, last.Key));
        Assert.False(order.LoadsBefore(disabled.Key, first.Key));
        Assert.True(order.LoadsBefore(early.Key, disabled.Key));
    }

    [Fact]
    public void AnOverriddenPlugin_DoesNotLoadBeforeTheWinnerOfItsLine()
    {
        var winner = Registered("A.esp", "HighPriorityMod", line: 0);
        var overridden = Registered("A.esp", "LowPriorityMod", line: 0);

        var order = Order([overridden, winner], winner);

        Assert.False(order.LoadsBefore(overridden.Key, winner.Key));
    }

    [Fact]
    public void APluginThatIsNotActive_WithNoLine_IsNotJudged()
    {
        var active = Registered("A.esp", "ModA", line: 0);
        var unlisted = Registered("B.esp", "ModB");

        var order = Order([active, unlisted], active);

        Assert.Null(order.LoadsBefore(unlisted.Key, active.Key));
        Assert.Null(order.LoadsBefore(active.Key, unlisted.Key));
    }

    [Fact]
    public void InJudgedOrder_PlacesEachPluginAsLoadsBeforeJudges_AndThoseWithNoLineLast()
    {
        var master = Registered("Fallout4.esm", "Masters");
        var unlisted = Registered("U.esp", "ModU");
        var last = Registered("C.esp", "ModC", line: 2);
        var disabled = Registered("B.esp", "ModB", line: 1);
        var first = Registered("A.esp", "ModA", line: 0);

        var order = OrderLoadingWithNoLine([unlisted, last, disabled, first, master], [master], master, first, last);

        Assert.Equal([master, first, disabled, last, unlisted], order.InJudgedOrder());
    }

    [Fact]
    public void AModsCleanedMaster_LoadedWithNoLine_IsNotImmutable_BecauseAModProvidesIt()
    {
        var cleaned = Registered("DLCCoast.esm", "CleanedMasters");

        var order = OrderLoadingWithNoLine([cleaned], [cleaned], cleaned);

        Assert.False(order.IsImmutable(cleaned.Key));
    }

    [Fact]
    public void AUserPluginInTheGameFolder_ProvidedByTheGame_IsImmutable_ActiveFromItsLine()
    {
        var placed = new RegisteredPlugin("UserPatch.esp", PluginOrigin.DataDirectory, Path.Combine(Data, "UserPatch.esp"), PluginProvider.Game, Line: 0);

        var order = Order([placed], placed);

        Assert.True(order.IsImmutable(placed.Key));
    }

    [Fact]
    public void APluginLoadedWithNoLineThatIsNoPluginInTheInstance_IsRefused()
    {
        var a = Registered("A.esp", "ModA");

        var refusal = LoadOrderSnapshot.RefusalOf([a], [a.Key], [new PluginAddress("Fallout4.esm", PluginOrigin.DataDirectory)]);

        Assert.Contains("Fallout4.esm", refusal, StringComparison.Ordinal);
    }

    [Fact]
    public void SamePlugins_LoadingADifferentPluginWithNoLine_AreDifferentValues()
    {
        var a = Registered("A.esp", "ModA");

        Assert.NotEqual(Order([a], a), OrderLoadingWithNoLine([a], [a], a));
    }

    [Fact]
    public void EmptySnapshot_HasNoActivePlugin_AndKnowsNoPlugin()
    {
        var order = Order([]);

        Assert.Empty(order.Active);
        Assert.Null(order.Plugin(new PluginAddress("A.esp", "ModA")));
        Assert.Null(order.LoadOrderIndex(new PluginAddress("A.esp", "ModA")));
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
            Data.ToLowerInvariant(), Instance.ToLowerInvariant(), GameRelease.Fallout4, [plugin], [plugin.Key], []);

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
        var order = new LoadOrderSnapshot(Data, Instance, GameRelease.Fallout4, plugins, active, []);

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

    [Fact]
    public void ProviderOf_IsWhatTheSnapshotNamed_WhateverTheOriginOrThePath()
    {
        var game = new RegisteredPlugin("Vanilla.esp", "ModA", @"C:\Elsewhere\Vanilla.esp", PluginProvider.Game, Line: null);
        var stray = new RegisteredPlugin("Stray.esp", "ModA", @"C:\Elsewhere\Stray.esp", PluginProvider.NoMod, Line: null);
        var inFolder = new PluginProvider.FromMod("ModA", @"C:\MO2\mods\ModA");
        var mod = new RegisteredPlugin("A.esp", "ModA", @"C:\MO2\mods\ModA\deep\A.esp", inFolder, Line: null);

        var order = Order([game, stray, mod]);

        Assert.Equal(
            (PluginProvider.Game, PluginProvider.NoMod, (PluginProvider)inFolder),
            (order.ProviderOf(game.Key), order.ProviderOf(stray.Key), order.ProviderOf(mod.Key)));
    }

    [Fact]
    public void ProviderOf_APluginNoneRegistered_IsNull()
    {
        Assert.Null(Order([]).ProviderOf(new PluginAddress("A.esp", "ModA")));
    }
}
