using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.LoadOrder.Tests.Plugins;

public sealed class LoadOrderTests
{
    private const string Data = @"C:\Games\Fallout4\Data";
    private const string Instance = @"C:\MO2\Fallout4";

    private static RegisteredPlugin Registered(string name, string origin, int? line = null, bool lineNamesIt = true) =>
        new(name, origin, Path.Combine(@"C:\MO2\mods", origin, name), new PluginProvider.FromMod(origin, Path.Combine(@"C:\MO2\mods", origin), Path.Combine(@"C:\MO2\source", origin)),
            line is { } place ? new PluginLine(place, lineNamesIt) : null, PluginStrings.None);

    private static LoadOrderSnapshot Order(RegisteredPlugin[] plugins, params RegisteredPlugin[] active) =>
        new(Data, Instance, GameRelease.Fallout4, plugins, [.. active.Select(p => p.Key)], [], [], [], [], Language.English);

    private static LoadOrderSnapshot OrderLoadingWithNoLine(
        RegisteredPlugin[] plugins, RegisteredPlugin[] loadedWithNoLine, params RegisteredPlugin[] active) =>
        new(Data, Instance, GameRelease.Fallout4, plugins, [.. active.Select(p => p.Key)], [.. loadedWithNoLine.Select(p => p.Key)], [], [], [], Language.English);

    private static readonly RegisteredPlugin A = Registered("A.esp", "ModA");

    private static readonly StampedFile AStrings = new(@"C:\MO2\Fallout4\mods\ModA\Strings\A_en.STRINGS", "1/2/3");

    private static LoadOrderSnapshot OfA(
        PluginAddress[]? loadedWithNoLine = null, StampedFile[]? archives = null, StampedFile[]? stringsFiles = null, Language language = Language.English) =>
        new(Data, Instance, GameRelease.Fallout4, [A], [A.Key], loadedWithNoLine ?? [], archives ?? [], stringsFiles ?? [AStrings], [], language);

    public static TheoryData<string, LoadOrderSnapshot> DifferingInOneField => new()
    {
        { "loads a plugin with no line", OfA(loadedWithNoLine: [A.Key]) },
        { "loads an archive", OfA(archives: [new(@"C:\Games\Fallout4\Data\A - Main.ba2", "1/2/3")]) },
        { "reads no strings file", OfA(stringsFiles: []) },
        { "reads its strings file under another stamp", OfA(stringsFiles: [AStrings with { Stamp = "1/2/4" }]) },
        { "shows texts in another strings language", OfA(language: Language.French) },
    };

    [Theory]
    [MemberData(nameof(DifferingInOneField))]
    public void SamePlugins_DifferingInOneField_AreDifferentValues(string _, LoadOrderSnapshot other)
    {
        Assert.NotEqual(OfA(), other);
    }

    public static TheoryData<string, RegisteredPlugin[], PluginAddress[], PluginAddress[], string> Refusals => new()
    {
        {
            "an active plugin that is no plugin in the instance",
            [A], [new PluginAddress("B.esp", "ModB")], [],
            "The active plugin B.esp from ModB is not a plugin in the snapshot."
        },
        {
            "two active plugins of one filename, as the game loads one file per name",
            [A, Registered("A.esp", "ModB")], [A.Key, new PluginAddress("A.esp", "ModB")], [],
            "The snapshot names more than one active A.esp: ModA, ModB. The game loads one file per name."
        },
        {
            "a plugin loaded with no line that is no plugin in the instance",
            [A], [A.Key], [new PluginAddress("Fallout4.esm", PluginOrigin.DataDirectory)],
            "The plugin loaded with no line Fallout4.esm from Data/ is not a plugin in the snapshot."
        },
    };

    [Theory]
    [MemberData(nameof(Refusals))]
    public void RefusalOf_NamesWhyThePluginsMakeNoSnapshot(
        string _, RegisteredPlugin[] plugins, PluginAddress[] active, PluginAddress[] loadedWithNoLine, string refusal)
    {
        Assert.Equal(refusal, LoadOrderSnapshot.RefusalOf(plugins, active, loadedWithNoLine));
    }

    [Fact]
    public void ASnapshotOfPluginsRefusalOfRefuses_IsNotConstructed()
    {
        var thrown = Assert.Throws<ArgumentException>(() => Order([A], Registered("B.esp", "ModB")));

        Assert.Equal("The active plugin B.esp from ModB is not a plugin in the snapshot.", thrown.Message);
    }

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
        var overridden = Registered("A.esp", "LowPriorityMod", line: 0, lineNamesIt: false);

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
    public void JudgedCopies_AreTheActivePlugins_AndTheCopyEachDisabledLineNames()
    {
        var active = Registered("A.esp", "ModA", line: 0);
        var overridden = Registered("B.esp", "FirstMod", line: 1, lineNamesIt: false);
        var named = Registered("B.esp", "SecondMod", line: 1);
        var unlisted = Registered("U.esp", "ModU");

        var order = Order([active, overridden, named, unlisted], active);

        Assert.Equal([active, named], order.JudgedCopies());
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
    public void EmptySnapshot_HasNoActivePlugin_AndKnowsNoPlugin()
    {
        var order = Order([]);

        Assert.Empty(order.Active);
        Assert.Null(order.Plugin(new PluginAddress("A.esp", "ModA")));
        Assert.Null(order.LoadOrderIndex(new PluginAddress("A.esp", "ModA")));
    }

    [Fact]
    public void EqualValues_HashAlike_WhenTheirPathsDifferOnlyInCase()
    {
        var plugin = Registered("A.esp", "ModA");
        var lower = new LoadOrderSnapshot(
            Data.ToLowerInvariant(), Instance.ToLowerInvariant(), GameRelease.Fallout4, [plugin], [plugin.Key], [], [], [], [], Language.English);

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
        var order = new LoadOrderSnapshot(Data, Instance, GameRelease.Fallout4, plugins, active, [], [], [], [], Language.English);

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
        var game = new RegisteredPlugin("Vanilla.esp", "ModA", @"C:\Elsewhere\Vanilla.esp", PluginProvider.Game, Line: null, PluginStrings.None);
        var stray = new RegisteredPlugin("Stray.esp", "ModA", @"C:\Elsewhere\Stray.esp", PluginProvider.NoMod, Line: null, PluginStrings.None);
        var inFolder = new PluginProvider.FromMod("ModA", @"C:\MO2\mods\ModA", @"C:\MO2\source\ModA");
        var mod = new RegisteredPlugin("A.esp", "ModA", @"C:\MO2\mods\ModA\deep\A.esp", inFolder, Line: null, PluginStrings.None);

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

    [Fact]
    public void PluginsDifferingOnlyInCase_AreInNoListButTheCollisions_ActiveOneIncluded()
    {
        var inactive = Registered("Dup.esp", "ModA");
        var active = Registered("dup.esp", "ModA");
        var other = Registered("Other.esp", "ModA");

        var order = Order([inactive, active, other], active, other);

        Assert.Equal([inactive, active], order.CollisionReasons().Select(c => c.Plugin));
        Assert.Equal([other], order.Plugins);
        Assert.Equal([other], order.Active);
        Assert.Null(order.LoadOrderIndex(active.Key));
        Assert.Null(order.Plugin(inactive.Key));
        Assert.Equal(0, order.LoadOrderIndex(other.Key));
    }

    public static TheoryData<string[][], string[]> CollisionCases => new()
    {
        { [["A.esp", "ModA"], ["B.esp", "ModA"]], [] },
        {
            [["Dup.esp", "ModA"], ["dup.esp", "ModA"]],
            [
                "Its name differs only in case from dup.esp from ModA, so no one can tell which the game loads. None is read.",
                "Its name differs only in case from Dup.esp from ModA, so no one can tell which the game loads. None is read.",
            ]
        },
        {
            [["Dup.esp", "ModA"], ["Dup.esp", "moda"]],
            [
                "Its origin differs only in case from Dup.esp from moda, so no one can tell which the game loads. None is read.",
                "Its origin differs only in case from Dup.esp from ModA, so no one can tell which the game loads. None is read.",
            ]
        },
        {
            [["Dup.esp", "ModA"], ["dup.esp", "ModA"], ["Dup.esp", "moda"]],
            [
                "Its name and origin differs only in case from dup.esp from ModA, Dup.esp from moda, so no one can tell which the game loads. None is read.",
                "Its name and origin differs only in case from Dup.esp from ModA, Dup.esp from moda, so no one can tell which the game loads. None is read.",
                "Its name and origin differs only in case from Dup.esp from ModA, dup.esp from ModA, so no one can tell which the game loads. None is read.",
            ]
        },
    };

    [Theory]
    [MemberData(nameof(CollisionCases))]
    public void CollisionReasons_NameWhatDiffersAndTheOthers(string[][] plugins, string[] reasons)
    {
        var order = Order([.. plugins.Select(p => Registered(p[0], p[1]))]);

        Assert.Equal(reasons, order.CollisionReasons().Select(c => c.Reason));
    }

}
