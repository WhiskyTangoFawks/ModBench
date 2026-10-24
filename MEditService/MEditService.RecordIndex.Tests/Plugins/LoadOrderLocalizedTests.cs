using System.Collections.Concurrent;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class LoadOrderLocalizedTests
{
    [Fact]
    public void ALocalizedPluginWhoseStringsFilesAreHandedInALaterSnapshot_IsReadAgainWithThem()
    {
        var holder = new LoadOrderHolder();
        FormKey doorFormKey = default;
        var data = new PluginFixtureBuilder("load-order-localized-handed-later")
            .WithPlugin("Fixture.esp", mod =>
            {
                var door = mod.Doors.AddNew("MainDoor");
                door.Name = new TranslatedString(Language.English, "The Big Door");
                mod.UsingLocalization = true;
                doorFormKey = door.FormKey;
            })
            .Build();
        using (data)
        {
            var strings = Path.Combine(data.DataFolder, "Strings");
            var aside = Path.Combine(data.DataFolder, "Strings aside");
            Directory.Move(strings, aside);
            using var index = Indexes.Open(holder);
            index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var key = new PluginAddress("Fixture.esp", PluginOrigin.DataDirectory);
            var before = Assert.Single(index.CopyIn(doorFormKey.ToString(), key).Require().Fields, f => f.Metadata.Name == "Name");

            Directory.Move(aside, strings);
            index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

            var after = Assert.Single(index.CopyIn(doorFormKey.ToString(), key).Require().Fields, f => f.Metadata.Name == "Name");
            Assert.Equal(
                [("Fixture_en.STRINGS, Fixture_en.ILSTRINGS, Fixture_en.DLSTRINGS", false), (null, true)],
                [(before.CheckError, before.Value?.ToString()?.Contains("The Big Door") == true),
                    (after.CheckError, after.Value?.ToString()?.Contains("The Big Door") == true)]);
        }
    }

    [Fact]
    public void ALocalizedPluginWhoseStringsTheGamesListsGainInALaterSnapshot_IsReadAgainWithThem()
    {
        using var data = LocalizedDoor("load-order-localized-game-lists", out var doorFormKey);
        var translation = StringsMovedIntoATranslation(data);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        var before = NameAfter(index, holder, data, data.Plugins, gameReads: [], doorFormKey);
        var after = NameAfter(index, holder, data, data.Plugins, gameReads: translation, doorFormKey);

        Assert.Equal([(true, false), (false, true)], [before, after]);
    }

    [Fact]
    public void ALocalizedPluginTheGameNoLongerResolvesItsNameTo_IsReadAgainWithoutTheGamesLists()
    {
        using var data = LocalizedDoor("load-order-localized-resolved", out var doorFormKey);
        var translation = StringsMovedIntoATranslation(data);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        var modCopy = Path.Combine(Directory.CreateDirectory(Path.Combine(data.DataFolder, "..", "mods", "ModB")).FullName, "Fixture.esp");
        File.Copy(Path.Combine(data.DataFolder, "Fixture.esp"), modCopy);
        var dataCopy = data.Plugins.Single();
        var modEntry = new LoadOrderEntry("Fixture.esp", modCopy, "ModB", dataCopy.Line, Enabled: true, Winning: false);

        var before = NameAfter(index, holder, data, [dataCopy, modEntry], gameReads: translation, doorFormKey);
        index.Receive(holder, SnapshotOf(data, [dataCopy with { Winning = false }, modEntry with { Winning = true }], translation));

        Assert.Equal((false, true), before);
        Assert.DoesNotContain("The Big Door", index.BodyOf(doorFormKey.ToString(), DataCopy), StringComparison.Ordinal);
        Assert.Contains("The Big Door", index.BodyOf(doorFormKey.ToString(), modEntry.Key), StringComparison.Ordinal);
    }

    [Fact]
    public void ALocalizedPluginWhoseStringsChangedBetweenSessions_IsReadAgainAtLoad()
    {
        using var data = LocalizedDoor("load-order-localized-sessions", out var doorFormKey);
        var holder = new LoadOrderHolder();
        using (var cold = Indexes.Open(holder)) cold.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        StringsOfADoorNamed("The New Door", Path.Combine(data.DataFolder, "Strings"));

        using var warm = Indexes.Open(holder);
        warm.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var name = Assert.Single(warm.CopyIn(doorFormKey.ToString(), DataCopy).Require().Fields, f => f.Metadata.Name == "Name");
        Assert.Contains("The New Door", name.Value?.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void ALocalizedPluginWhoseStringsAreRewrittenInPlace_IsReadAgainWithThem()
    {
        using var data = LocalizedDoor("load-order-localized-rewritten", out var doorFormKey);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        StringsOfADoorNamed("The New Door", Path.Combine(data.DataFolder, "Strings"));

        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        var name = Assert.Single(index.CopyIn(doorFormKey.ToString(), DataCopy).Require().Fields, f => f.Metadata.Name == "Name");
        Assert.Contains("The New Door", name.Value?.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void ALocalizedPluginWhoseStringsTheGameReadsAreRewrittenInPlace_IsReadAgainWithThem()
    {
        using var data = LocalizedDoor("load-order-localized-game-rewritten", out var doorFormKey);
        var translation = StringsMovedIntoATranslation(data);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Receive(holder, SnapshotOf(data, data.Plugins, translation));
        StringsOfADoorNamed("The New Door", Path.GetDirectoryName(translation[0]).Require());

        index.Receive(holder, SnapshotOf(data, data.Plugins, translation));

        var name = Assert.Single(index.CopyIn(doorFormKey.ToString(), DataCopy).Require().Fields, f => f.Metadata.Name == "Name");
        Assert.Contains("The New Door", name.Value?.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void ALocalizedPluginWhoseStringsTheGameReadsChangedBetweenSessions_IsReadAgainAtLoad()
    {
        using var data = LocalizedDoor("load-order-localized-game-sessions", out var doorFormKey);
        var translation = StringsMovedIntoATranslation(data);
        var coldHolder = new LoadOrderHolder();
        using (var cold = Indexes.Open(coldHolder)) cold.Receive(coldHolder, SnapshotOf(data, data.Plugins, translation, instanceRoot: data.InstanceRoot));
        StringsOfADoorNamed("The New Door", Path.GetDirectoryName(translation[0]).Require());

        var warmHolder = new LoadOrderHolder();
        using var warm = Indexes.Open(warmHolder);
        warm.Receive(warmHolder, SnapshotOf(data, data.Plugins, translation, instanceRoot: data.InstanceRoot));

        var name = Assert.Single(warm.CopyIn(doorFormKey.ToString(), DataCopy).Require().Fields, f => f.Metadata.Name == "Name");
        Assert.Contains("The New Door", name.Value?.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void ALocalizedPluginWhoseStringsInAnArchiveTheGameLoadsAreRewrittenInPlace_IsReadAgainWithThem()
    {
        using var data = LocalizedDoor("load-order-localized-archive-rewritten", out var doorFormKey);
        var archive = Path.Combine(data.DataFolder, "Translation - Main.ba2");
        var strings = Path.Combine(data.DataFolder, "Strings");
        StringsBa2.Pack(Directory.EnumerateFiles(strings), archive);
        Directory.Delete(strings, recursive: true);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Receive(holder, SnapshotOf(data, data.Plugins, gameReads: [], gameArchives: [archive]));
        using (var rewritten = new ScratchDirectory("load-order-localized-archive-strings-"))
        {
            StringsOfADoorNamed("The New Door", rewritten.Path);
            StringsBa2.Pack(Directory.EnumerateFiles(rewritten.Path), archive);
        }

        index.Receive(holder, SnapshotOf(data, data.Plugins, gameReads: [], gameArchives: [archive]));

        var name = Assert.Single(index.CopyIn(doorFormKey.ToString(), DataCopy).Require().Fields, f => f.Metadata.Name == "Name");
        Assert.Contains("The New Door", name.Value?.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void ALocalizedPluginUnderAStringsLanguageItHoldsNoStringsFor_NamesThatLanguagesFiles_UntilTheLanguageChangesBack()
    {
        using var data = LocalizedDoor("load-order-localized-language", out var doorFormKey);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Receive(holder, SnapshotOf(data, data.Plugins, gameReads: []));
        string? NameCheckError() =>
            Assert.Single(index.CopyIn(doorFormKey.ToString(), DataCopy).Require().Fields, f => f.Metadata.Name == "Name").CheckError;
        string? NameCheckErrorIn(Language language)
        {
            ReceiveInLanguage(index, holder, data, language);
            return NameCheckError();
        }

        var (first, second, third) = (NameCheckError(), NameCheckErrorIn(Language.German), NameCheckErrorIn(Language.English));

        Assert.Equal(
            (null, "Fixture_de.STRINGS, Fixture_de.ILSTRINGS, Fixture_de.DLSTRINGS", null),
            (first, second, third));
    }

    private static void ReceiveInLanguage(OpenedIndex index, LoadOrderHolder holder, PluginFixtureData data, Language language)
    {
        var before = index.Sequence;
        index.Receive(holder, SnapshotOf(data, data.Plugins, gameReads: [], language: language));
        Waits.Reached(() => index.Sequence > before, "the sequence moving");
        Waits.Reached(() => index.Status.State != LoadOrderState.Reconciling, "the reconcile");
    }

    [Fact]
    public void ALocalizedRecordsListedName_FollowsTheStringsLanguageTheLoadOrderNames()
    {
        using var data = new PluginFixtureBuilder("load-order-localized-listing")
            .WithPlugin("Fixture.esp", mod =>
            {
                mod.UsingLocalization = true;
                mod.Activators.AddNew("MainLever").Name = new TranslatedString(
                    Language.English,
                    new KeyValuePair<Language, string>(Language.French, "Levier"),
                    new KeyValuePair<Language, string>(Language.English, "Lever"));
            })
            .Build();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        string? ListedName() =>
            index.Queries.GetRecords(["acti"], DataCopy, search: null, limit: 10, offset: 0).Value().Items.Single().FullName;
        string? ListedNameIn(Language language)
        {
            ReceiveInLanguage(index, holder, data, language);
            return ListedName();
        }

        var (french, english) = (ListedNameIn(Language.French), ListedNameIn(Language.English));

        Assert.Equal(("Levier", "Lever"), (french, english));
    }

    [Fact]
    public void AChangeOfTheStringsLanguage_NeverShowsReadyOnceTheSequenceHasMovedAndTheReconcileHasNotCaughtUp()
    {
        using var data = LocalizedDoor("load-order-language-status", out _);
        var holder = new LoadOrderHolder();
        var watching = new StatusWatchingAdapter();
        using var index = Indexes.Open(holder, watching);
        watching.Index = index;
        index.Receive(holder, SnapshotOf(data, data.Plugins, gameReads: []));
        var settled = watching.Settled = index.Sequence;
        watching.Seen.Clear();

        index.Receive(holder, SnapshotOf(data, data.Plugins, gameReads: [], language: Language.German));
        Waits.Reached(() => index.Sequence > settled && index.Status.State == LoadOrderState.Ready, "the reconcile");

        Assert.DoesNotContain((true, LoadOrderState.Ready), watching.Seen.Select(seen => (seen.SequenceMoved, seen.State)));
        Assert.Contains(watching.Seen, seen => seen.SequenceMoved);
    }

    private sealed class StatusWatchingAdapter : DelegatingPluginAdapter
    {
        public StatusWatchingAdapter() : base(TestAdapters.Mutagen()) { }

        public OpenedIndex? Index { get; set; }
        public ConcurrentQueue<(bool SequenceMoved, LoadOrderState State)> Seen { get; } = new();
        public long Settled { get; set; }

        public override void KeepHashesOf(IReadOnlySet<string> pluginPaths)
        {
            Watch();
            base.KeepHashesOf(pluginPaths);
        }

        public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
            ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas, PluginStrings strings)
        {
            Watch();
            return base.OpenDocuments(modPath, loadOrder, schemas, strings);
        }

        private void Watch()
        {
            var index = Index ?? throw new InvalidOperationException("Expected the adapter's Index to be set before any reconcile.");
            Seen.Enqueue((index.Sequence > Settled, index.Status.State));
        }
    }

    [Fact]
    public void AChangeOfTheStringsLanguage_AdvancesTheSequenceEvenWhereNoPluginIsReadAgain()
    {
        using var fx = new PluginFixtureBuilder("load-order-language-sequence")
            .WithPlugin("Fixture.esp", mod => mod.Doors.AddNew("MainDoor"))
            .BuildScattered();
        using var index = Indexes.Reconciled(fx);
        index.Settled();
        var before = index.Sequence;

        index.Receive(index.Holder, SnapshotPlugins.Snapshot(fx.DataFolder, null, GameRelease.Fallout4, fx.Plugins, stringsLanguage: Language.German));

        Waits.Reached(() => index.Sequence > before, "the sequence moving");
    }

    private static readonly PluginAddress DataCopy = new("Fixture.esp", PluginOrigin.DataDirectory);

    private static PluginFixtureData LocalizedDoor(string name, out FormKey doorFormKey)
    {
        FormKey door = default;
        var data = new PluginFixtureBuilder(name)
            .WithPlugin("Fixture.esp", mod =>
            {
                var added = mod.Doors.AddNew("MainDoor");
                added.Name = new TranslatedString(Language.English, "The Big Door");
                mod.UsingLocalization = true;
                door = added.FormKey;
            })
            .Build();
        doorFormKey = door;
        return data;
    }

    private static string[] StringsMovedIntoATranslation(PluginFixtureData data)
    {
        var translation = Path.Combine(data.DataFolder, "..", "Translation", "Strings");
        Directory.CreateDirectory(Path.GetDirectoryName(translation).Require());
        Directory.Move(Path.Combine(data.DataFolder, "Strings"), translation);
        return [.. Directory.EnumerateFiles(translation)];
    }

    private static void StringsOfADoorNamed(string doorName, string stringsFolder)
    {
        using var scratch = new ScratchDirectory("load-order-localized-new-strings-");
        var mod = new Mutagen.Bethesda.Fallout4.Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4)
        {
            UsingLocalization = true,
        };
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, doorName);
        ((IModGetter)mod).WriteToBinary(Path.Combine(scratch.Path, "Fixture.esp"));
        foreach (var file in Directory.EnumerateFiles(Path.Combine(scratch.Path, "Strings")))
            File.Copy(file, Path.Combine(stringsFolder, Path.GetFileName(file)), overwrite: true);
    }

    private static LoadOrderSnapshot SnapshotOf(
        PluginFixtureData data, IReadOnlyList<LoadOrderEntry> plugins, string[] gameReads, string[]? gameArchives = null, string? instanceRoot = null,
        Language language = Language.English) =>
        new(data.DataFolder, instanceRoot, GameRelease.Fallout4, SnapshotPlugins.Of(plugins), SnapshotPlugins.Active(plugins),
            SnapshotPlugins.LoadedWithNoLine(plugins), [.. (gameArchives ?? []).Select(HandedStrings.Stamped)], [.. gameReads.Select(HandedStrings.Stamped)], [], language);

    private static (bool NamesMissing, bool ReadsTheDoor) NameAfter(
        OpenedIndex index, LoadOrderHolder holder, PluginFixtureData data, IReadOnlyList<LoadOrderEntry> plugins, string[] gameReads,
        FormKey doorFormKey)
    {
        index.Receive(holder, SnapshotOf(data, plugins, gameReads));
        var name = Assert.Single(index.CopyIn(doorFormKey.ToString(), DataCopy).Require().Fields, f => f.Metadata.Name == "Name");
        return (name.CheckError is not null, name.Value?.ToString()?.Contains("The Big Door", StringComparison.Ordinal) == true);
    }

    [Theory]
    [InlineData(new[] { "Fixture_en.ILSTRINGS", "Fixture_en.DLSTRINGS" }, "Fixture_en.STRINGS")]
    [InlineData(new[] { "Fixture_en.ILSTRINGS" }, "Fixture_en.STRINGS, Fixture_en.DLSTRINGS")]
    public void ALocalizedPluginMissingStringsFiles_NamesThemOnItsName(string[] stringsFilesKept, string expected) =>
        Assert.Equal(expected, NameCheckErrorLeaving(stringsFilesKept));

    private static string? NameCheckErrorLeaving(string[] stringsFilesKept)
    {
        var holder = new LoadOrderHolder();
        FormKey doorFormKey = default;
        var data = new PluginFixtureBuilder("load-order-localized-missing")
            .WithPlugin("Fixture.esp", mod =>
            {
                var door = mod.Doors.AddNew("MainDoor");
                door.Name = new TranslatedString(Language.English, "The Big Door");
                mod.UsingLocalization = true;
                doorFormKey = door.FormKey;
            })
            .Build();
        using (data)
        {
            var strings = Path.Combine(data.DataFolder, "Strings");
            Directory.Delete(strings, recursive: true);
            Directory.CreateDirectory(strings);
            foreach (var kept in stringsFilesKept) File.WriteAllBytes(Path.Combine(strings, kept), []);

            using var index = Indexes.Open(holder);
            index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

            var detail = index.CopyIn(doorFormKey.ToString(), new PluginAddress("Fixture.esp", PluginOrigin.DataDirectory));
            return Assert.Single(detail.Require().Fields, f => f.Metadata.Name == "Name").CheckError;
        }
    }

    [Fact]
    public void ComparingCopiesOfARecordWhoseStringsFilesAreMissing_CarriesEachColumnsStringsFileOnItsName()
    {
        var holder = new LoadOrderHolder();
        FormKey doorFormKey = default;
        var data = new PluginFixtureBuilder("load-order-localized-missing-compare")
            .WithPlugin("Fixture.esp", mod =>
            {
                var door = mod.Doors.AddNew("MainDoor");
                door.Name = new TranslatedString(Language.English, "The Big Door");
                mod.UsingLocalization = true;
                doorFormKey = door.FormKey;
            })
            .WithPlugin("Other.esp", (mod, built) =>
            {
                mod.UsingLocalization = true;
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = built[0].ModKey });
                var copy = (Mutagen.Bethesda.Fallout4.Door)built[0].Doors.Single().DeepCopy();
                copy.Name = new TranslatedString(Language.English, "The Other Door");
                mod.Doors.Set(copy);
            })
            .Build();
        using (data)
        {
            Directory.Delete(Path.Combine(data.DataFolder, "Strings"), recursive: true);

            using var index = Indexes.Open(holder);
            index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

            var compare = index.Queries.GetCompare(doorFormKey.ToString()).Value().Require();
            var name = Assert.Single(compare.Diffs, diff => diff.FieldName == "Name");
            Assert.Equal(
                ["Fixture_en.STRINGS, Fixture_en.ILSTRINGS, Fixture_en.DLSTRINGS", "Other_en.STRINGS, Other_en.ILSTRINGS, Other_en.DLSTRINGS"],
                name.CheckErrors.Require().OrderBy(entry => entry.Key, StringComparer.Ordinal).Select(entry => entry.Value));
        }
    }
}
