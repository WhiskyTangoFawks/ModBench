using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class PluginFilePathsTests : IDisposable
{
    private static readonly PluginAddress Compiled = new("Holding.esp", "ModA");
    private static readonly PluginAddress Beside = new("Beside.esp", "ModB");
    private const string StainPath = @"Decals\Stain_d.dds";

    private readonly GatedPluginAdapter _holdingUnreadable = new(poisonPlugin: Compiled.Name);
    private ScatteredFixtureData? _fixture;
    private FormKey _holder;

    public void Dispose()
    {
        _holdingUnreadable.Dispose();
        _fixture?.Dispose();
    }

    private ScatteredFixtureData Fixture => _fixture ?? throw new InvalidOperationException("Expected a built fixture.");

    private void Build(bool compiled, params PluginAddress[] plugins)
    {
        var builder = new PluginFixtureBuilder("plugin-file-paths");
        foreach (var plugin in plugins)
        {
            builder.WithPlugin(plugin.Name, mod =>
            {
                var set = mod.TextureSets.AddNew("Holder");
                set.Diffuse = StainPath;
                if (plugin == Compiled) _holder = set.FormKey;
                mod.TextureSets.AddNew("Other");
            }, origin: plugin.Origin);
        }
        var built = builder.BuildScattered();
        _fixture = compiled ? built.CompiledPlugin() : built;
    }

    private string SourceFileHolding(PluginAddress plugin, string editorId = "Holder") =>
        Directory.EnumerateFiles(
                PluginSourceRoot.In(Fixture.Plugins.Single(entry => entry.Key == plugin).ModFolderOf(), plugin.Name), "*.json", SearchOption.AllDirectories)
            .Single(file => File.ReadAllText(file).Contains($"\"{editorId}\"", StringComparison.Ordinal));

    private void CopyToClaimTheFormKey(PluginAddress plugin, string editorId)
    {
        var document = SourceFileHolding(plugin, editorId);
        File.Copy(document, Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(document) ?? "", "Backup")).FullName, Path.GetFileName(document)));
    }

    [Fact]
    public void ACompiledPlugin_AnswersEachPathItsSourceNames_OnTheFileThatHoldsTheRecord()
    {
        Build(compiled: true, Compiled);
        using var index = Indexes.Reconciled(Fixture);

        var answered = Assert.Single(index.Queries.GetFilePaths(null).Value());

        var path = Assert.Single(answered.Paths);
        Assert.Equal((Compiled, "Diffuse", "Textures/Decals/Stain_d.dds", null), (answered.Plugin, path.FieldPath, path.DataPath, answered.Failure));
        Assert.Equal(Path.GetRelativePath(Fixture.Plugins.Single().ModFolderOf(), SourceFileHolding(Compiled)), path.SourceRelativePath);
        Assert.Empty(answered.Unread);
    }

    [Fact]
    public void ARecordWhoseResultTheCallerHolds_AnswersUnchanged_AndLeavesItsRowsOut()
    {
        Build(compiled: true, Compiled);
        using var index = Indexes.Reconciled(Fixture);
        var first = Assert.Single(index.Queries.GetFilePaths(Compiled).Value());
        var holder = Assert.Single(first.Records ?? [], record => record.FormKey == _holder.ToString());
        var held = new RecordsAsked(null, [new KnownResult(Compiled, holder.FormKey, holder.ResultId)]);

        var again = Assert.Single(index.Queries.GetFilePaths(Compiled, held).Value());

        Assert.Equal((false, true), (holder.Unchanged, Assert.Single(again.Records ?? [], record => record.FormKey == holder.FormKey).Unchanged));
        Assert.Empty(again.Paths);
    }

    [Fact]
    public void RecordsThatNameDifferentPaths_AnswerDifferentResultIds()
    {
        Build(compiled: true, Compiled);
        using var index = Indexes.Reconciled(Fixture);
        var other = FormKey.Factory("000FFF:Holding.esp").ToString();

        var answered = Assert.Single(index.Queries.GetFilePaths(Compiled, new RecordsAsked([_holder.ToString(), other], [])).Value());

        Assert.Equal(2, (answered.Records ?? []).Select(record => record.ResultId).Distinct().Count());
    }

    [Fact]
    public void AskedForRecords_AnswersTheSameAsTheWholeAnswerDoesOfThoseRecords()
    {
        Build(compiled: true, Compiled);
        using var index = Indexes.Reconciled(Fixture);
        var whole = Assert.Single(index.Queries.GetFilePaths(Compiled).Value());

        var keyed = Assert.Single(index.Queries.GetFilePaths(Compiled, new RecordsAsked([_holder.ToString()], [])).Value());

        Assert.Equal((whole.Paths, whole.Scripts, whole.Unread, whole.Records), (keyed.Paths, keyed.Scripts, keyed.Unread, keyed.Records), new SameLists());
    }

    private sealed class SameLists : IEqualityComparer<(IReadOnlyList<NamedFilePath>, IReadOnlyList<NamedScript>, IReadOnlyList<string>, IReadOnlyList<RecordResult>?)>
    {
        public bool Equals((IReadOnlyList<NamedFilePath>, IReadOnlyList<NamedScript>, IReadOnlyList<string>, IReadOnlyList<RecordResult>?) x, (IReadOnlyList<NamedFilePath>, IReadOnlyList<NamedScript>, IReadOnlyList<string>, IReadOnlyList<RecordResult>?) y) =>
            x.Item1.SequenceEqual(y.Item1) && x.Item2.SequenceEqual(y.Item2) && x.Item3.SequenceEqual(y.Item3)
            && (x.Item4 ?? []).Select(record => (record.FormKey, record.ResultId)).SequenceEqual((y.Item4 ?? []).Select(record => (record.FormKey, record.ResultId)));

        public int GetHashCode((IReadOnlyList<NamedFilePath>, IReadOnlyList<NamedScript>, IReadOnlyList<string>, IReadOnlyList<RecordResult>?) obj) => 0;
    }

    [Fact]
    public void ARecordWhoseResultTheCallerHoldsAnotherOf_AnswersFull()
    {
        Build(compiled: true, Compiled);
        using var index = Indexes.Reconciled(Fixture);
        var held = new RecordsAsked(null, [new KnownResult(Compiled, _holder.ToString(), "stale")]);

        var answered = Assert.Single(index.Queries.GetFilePaths(Compiled, held).Value());

        Assert.False(Assert.Single(answered.Records ?? [], record => record.FormKey == _holder.ToString()).Unchanged);
        Assert.Single(answered.Paths);
    }

    [Fact]
    public void AskedForRecords_AnswersOnlyThose_AndAnEmptyResultForOneThatNamesNothing()
    {
        Build(compiled: true, Compiled);
        using var index = Indexes.Reconciled(Fixture);
        var other = FormKey.Factory("000FFF:Holding.esp").ToString();

        var answered = Assert.Single(index.Queries.GetFilePaths(Compiled, new RecordsAsked([other], [])).Value());

        Assert.Empty(answered.Paths);
        Assert.Equal([other], (answered.Records ?? []).Select(record => record.FormKey));
    }

    [Fact]
    public void ACompiledPlugin_AnswersEachScriptItsSourceAttaches_OnTheFileThatHoldsTheRecord()
    {
        FormKey attaching = default;
        using var fixture = new PluginFixtureBuilder("plugin-file-scripts")
            .WithPlugin(Compiled.Name, mod =>
            {
                var npc = mod.Npcs.AddNew("Holder");
                npc.VirtualMachineAdapter = new Mutagen.Bethesda.Fallout4.VirtualMachineAdapter();
                npc.VirtualMachineAdapter.Scripts.Add(new Mutagen.Bethesda.Fallout4.ScriptEntry { Name = "Ns:Attached" });
                attaching = npc.FormKey;
            }, origin: Compiled.Origin)
            .BuildScattered()
            .CompiledPlugin();
        using var index = Indexes.Reconciled(fixture);

        var answered = Assert.Single(index.Queries.GetFilePaths(null).Value());

        var script = Assert.Single(answered.Scripts);
        Assert.Equal((attaching.ToString(), "VirtualMachineAdapter.Scripts[0].Name", "Ns:Attached"), (script.FormKey, script.FieldPath, script.Name));
        Assert.Contains("Holder", script.SourceRelativePath, StringComparison.Ordinal);
    }

    [Fact]
    public void PlacingARecord_LocatesItOnce()
    {
        Build(compiled: true, Compiled);
        var source = new CountingTreeSource(TestAdapters.Source());
        using var index = Indexes.Reconciled(Fixture, source: source);
        var before = source.LocatesAsked;

        Assert.Single(index.Queries.GetFilePaths(null).Value());

        Assert.Equal(1, source.LocatesAsked - before);
    }

    [Fact]
    public void APluginWithNoSource_IsNotAnswered()
    {
        Build(compiled: false, Compiled);
        using var index = Indexes.Reconciled(Fixture);

        Assert.Empty(index.Queries.GetFilePaths(null).Value());
    }

    [Fact]
    public void AskedForOnePlugin_AnswersThatPluginAlone()
    {
        Build(compiled: true, Compiled, Beside);
        using var index = Indexes.Reconciled(Fixture);

        var answered = Assert.Single(index.Queries.GetFilePaths(Beside).Value());

        Assert.Equal(Beside, answered.Plugin);
        Assert.Equivalent(new[] { Compiled, Beside }, index.Queries.GetFilePaths(null).Value().Select(plugin => plugin.Plugin), strict: true);
    }

    [Fact]
    public void ARecordWhosePathIsRefused_IsUnreadOnItsPlugin_AndThePathsBesideItStillAnswer()
    {
        FormKey naming = default, refused = default;
        using var fixture = new PluginFixtureBuilder("plugin-file-paths-unread")
            .WithPlugin(Compiled.Name, mod =>
            {
                var holder = mod.TextureSets.AddNew("Holder");
                holder.Diffuse = StainPath;
                naming = holder.FormKey;
                var misplaced = mod.TextureSets.AddNew("Misplaced");
                misplaced.Diffuse = @"Other\Stain_d.dds";
                refused = misplaced.FormKey;
            }, origin: Compiled.Origin)
            .BuildScattered()
            .CompiledPlugin();
        var entry = fixture.Plugins.Single();
        using (var live = Indexes.Reconciled(fixture.DataFolder, fixture.Plugins))
            entry.HandEdit(live.DocumentOf(refused.ToString(), entry.Key), @"Other\\Stain_d.dds", "Data/Stain_d.dds");
        using var index = Indexes.Reconciled(fixture.DataFolder, fixture.Plugins);

        var answered = Assert.Single(index.Queries.GetFilePaths(null).Value());

        Assert.Equal([naming.ToString()], answered.Paths.Select(path => path.FormKey));
        Assert.StartsWith($"{refused} in {Compiled.Name} ({Compiled.Origin}): ", Assert.Single(answered.Unread));
    }

    [Fact]
    public void ARecordTheSourceCannotPlace_IsAPlacementFailureOfThatPlugin_AndItsFilesAreEmpty()
    {
        Build(compiled: true, Compiled);
        using var index = Indexes.Reconciled(Fixture);

        File.Delete(SourceFileHolding(Compiled));

        var answered = Assert.Single(index.Queries.GetFilePaths(null).Value());
        Assert.Empty(answered.Paths);
        Assert.Contains(_holder.ToString(), answered.Failure, StringComparison.Ordinal);
        Assert.Equal(ProblemsFailureKind.Placement, answered.FailureKind);
    }

    [Fact]
    public void APluginWhosePluginSourceIsUnreadable_IsAFailureNamingWhy_AndItsFilesAreEmpty()
    {
        Build(compiled: true, Compiled);
        CopyToClaimTheFormKey(Compiled, "Other");
        using var index = Indexes.Reconciled(Fixture);
        var why = index.PluginResponseOf(Compiled)?.PluginSourceUnreadable ?? throw new InvalidOperationException("Expected an unreadable plugin source.");

        var answered = Assert.Single(index.Queries.GetFilePaths(null).Value());

        Assert.Empty(answered.Paths);
        Assert.Equal((why.Reason, ProblemsFailureKind.Placement), (answered.Failure, answered.FailureKind));
    }

    [Theory]
    [InlineData("body = 'not a document'")]
    [InlineData("record_type = 'ZZZZ'")]
    public void ACopyThatCannotBeRead_IsUnreadNamingItsPlugin_AndTheCopiesBesideItStillAnswer(string damage)
    {
        FormKey broken = default, sibling = default;
        using var fixture = new PluginFixtureBuilder("plugin-file-paths-throws")
            .WithPlugin(Compiled.Name, mod =>
            {
                var first = mod.TextureSets.AddNew("First");
                first.Diffuse = StainPath;
                var second = mod.TextureSets.AddNew("Second");
                second.Diffuse = StainPath;
                (broken, sibling) = (first.FormKey, second.FormKey);
            }, origin: Compiled.Origin)
            .BuildScattered()
            .CompiledPlugin();
        using var index = Indexes.Reconciled(fixture, fixture.InstanceRoot);
        IndexFiles.Execute(fixture.InstanceRoot, $"UPDATE mirror.records SET {damage} WHERE form_key = '{broken}'");

        var answered = Assert.Single(index.Queries.GetFilePaths(null).Value());

        Assert.Equal([sibling.ToString()], answered.Paths.Select(path => path.FormKey));
        Assert.StartsWith($"{broken} in {Compiled.Name} ({Compiled.Origin}): ", Assert.Single(answered.Unread));
        Assert.Null(answered.Failure);
    }

    [Fact]
    public void AFileTheReadStoppedAt_IsUnread_AndThePathsOfTheRestStillAnswer()
    {
        Build(compiled: true, Compiled);
        using var index = Indexes.Reconciled(Fixture, adapter: _holdingUnreadable);
        CopyToClaimTheFormKey(Compiled, "Other");
        index.NextCheckUntil(() => index.Status.Failures.Count > 0, "the re-read's failure");

        var answered = Assert.Single(index.Queries.GetFilePaths(null).Value());

        Assert.Equal([_holder.ToString()], answered.Paths.Select(path => path.FormKey));
        Assert.Equal(2, answered.Unread.Count);
        Assert.Contains(answered.Unread, file => file.Contains("Backup", StringComparison.Ordinal));
        Assert.Contains("Could not read this plugin", answered.Failure, StringComparison.Ordinal);
    }

    [Fact]
    public void APluginWhoseLaterReadFailed_IsAFailureNamingWhy_AndItsFilesAreEmpty()
    {
        Build(compiled: true, Compiled);
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(Fixture, Fixture.InstanceRoot, notifications: notifications);
        var file = SourceFileHolding(Compiled);
        var before = notifications.Notifications.Count;

        index.Unsaved.Apply([new DocumentChange(file, File.ReadAllText(file).Replace("\"Holder\"", "\"Holder", StringComparison.Ordinal))]);
        Waits.Reached(() => notifications.Since(before).Any(n => Announcements.PluginChanged(Fixture.Plugins.Single())(n)), "the hand-over's announcement");

        var answered = Assert.Single(index.Queries.GetFilePaths(null).Value());
        Assert.Empty(answered.Paths);
        Assert.Equal(ProblemsFailureKind.LaterRead, answered.FailureKind);
        Assert.Contains("is no record document", answered.Failure, StringComparison.Ordinal);
    }

    [Fact]
    public void AskedBeforeASnapshotNoModProvidesACompiledPluginIn_IsReconciled_TheFilesAnswerThatPluginWithAFailure()
    {
        Build(compiled: true, Compiled);
        var holder = new LoadOrderHolder();
        OpenedIndex? reconciled = null;
        IReadOnlyList<PluginFilePaths>? answered = null;
        using var loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider([], entry =>
        {
            if (reconciled is { } ready && entry.Message.StartsWith("Reconciling load order", StringComparison.Ordinal))
                answered ??= ready.Queries.GetFilePaths(null).Value();
        })));
        using var index = Indexes.Open(holder, loggerFactory: loggers);
        index.Reconcile(holder, Fixture.DataFolder, Fixture.Plugins, GameRelease.Fallout4);
        reconciled = index;

        index.Reconcile(
            holder, Fixture.DataFolder, [Fixture.Plugins.Single() with { NamedProvider = PluginProvider.NoMod }], GameRelease.Fallout4);

        var unprovided = Assert.Single(answered ?? throw new InvalidOperationException("Expected the answer to be taken."));
        Assert.Empty(unprovided.Paths);
        Assert.Contains("no mod folder provides it", unprovided.Failure, StringComparison.Ordinal);
        Assert.Equal(ProblemsFailureKind.Placement, unprovided.FailureKind);
    }
}
