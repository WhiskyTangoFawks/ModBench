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

    private static PluginFixtureData LocalizedTree()
    {
        var data = new PluginFixtureBuilder("load-order-localized-tree")
            .WithPlugin("Tree.esp", mod =>
            {
                mod.UsingLocalization = true;
                mod.Activators.AddNew("MainLever").Name = new TranslatedString(
                    Language.English,
                    new KeyValuePair<Language, string>(Language.French, "Levier"),
                    new KeyValuePair<Language, string>(Language.English, "Lever"));
            }, origin: "Tree")
            .Build();
        SourceMods.Init(data.Plugins.Single());
        return data;
    }

    private static string? TreeNameIn(OpenedIndex index, LoadOrderHolder holder, PluginFixtureData data, Language language)
    {
        index.Receive(holder, SnapshotOf(data, data.Plugins, gameReads: [], instanceRoot: data.InstanceRoot, language: language));
        return index.Queries.GetRecords(["acti"], data.Plugins.Single().Key, search: null, limit: 10, offset: 0).Value().Items.Single().FullName;
    }

    [Fact]
    public void ATreesListedName_FollowsTheStringsLanguageWhenItMoves()
    {
        using var data = LocalizedTree();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        var names = new[] { TreeNameIn(index, holder, data, Language.English), TreeNameIn(index, holder, data, Language.French) };

        Assert.Equal(new[] { "Lever", "Levier" }, names);
    }

    [Fact]
    public void ATreesListedName_FollowsTheStringsLanguageANewSessionNames()
    {
        using var data = LocalizedTree();
        var holder = new LoadOrderHolder();
        using (var cold = Indexes.Open(holder)) TreeNameIn(cold, holder, data, Language.English);
        using var warm = Indexes.Open(holder);

        Assert.Equal("Levier", TreeNameIn(warm, holder, data, Language.French));
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

        public override void KeepStateOf(IReadOnlySet<string> pluginPaths)
        {
            Watch();
            base.KeepStateOf(pluginPaths);
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

    private static PluginFixtureData LocalizedDoor(
        string name, out FormKey doorFormKey, Func<PluginFixtureBuilder, PluginFixtureBuilder>? withTheRest = null)
    {
        FormKey door = default;
        var builder = new PluginFixtureBuilder(name)
            .WithPlugin("Fixture.esp", mod =>
            {
                var added = mod.Doors.AddNew("MainDoor");
                added.Name = new TranslatedString(Language.English, "The Big Door");
                mod.UsingLocalization = true;
                door = added.FormKey;
            });
        var data = (withTheRest?.Invoke(builder) ?? builder).Build();
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
        PluginFixtureData data, IReadOnlyList<LoadOrderEntry> plugins, string[] gameReads, string? instanceRoot = null,
        Language language = Language.English) =>
        new(data.DataFolder, instanceRoot, GameRelease.Fallout4, SnapshotPlugins.Of(plugins), SnapshotPlugins.Active(plugins),
            SnapshotPlugins.LoadedWithNoLine(plugins), [], [], [.. gameReads.Select(HandedStrings.Stamped)], [], language);

    [Fact]
    public void ComparingCopiesOfARecordWhoseStringsFilesAreMissing_CarriesEachColumnsStringsFileOnItsName()
    {
        var holder = new LoadOrderHolder();
        using (var data = LocalizedDoor("load-order-localized-missing-compare", out var doorFormKey, builder => builder
            .WithPlugin("Other.esp", (mod, built) =>
            {
                mod.UsingLocalization = true;
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = built[0].ModKey });
                var copy = (Mutagen.Bethesda.Fallout4.Door)built[0].Doors.Single().DeepCopy();
                copy.Name = new TranslatedString(Language.English, "The Other Door");
                mod.Doors.Set(copy);
            })))
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
