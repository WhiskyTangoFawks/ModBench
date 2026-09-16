using System.Diagnostics;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Http;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Xunit.Abstractions;

namespace MEditService.Tests.RealData;

/// <summary>The real cut-down plugin tracked under a live Source watch, so what Track's thousands of
/// files and a wide hand-written burst cost the projector is measured on authentic data.</summary>
public sealed class SourceWatchRealDataFixture : IDisposable
{
    public const string Origin = "FixtureMod";

    public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-source-watch-").FullName;
    public IndexProjector Index { get; }
    public PluginCopyKey Plugin { get; } = new(CutDownPluginFixture.PluginFileName, Origin);
    internal InMemoryNotificationPublisher Notifications { get; } = new();

    /// <summary>How many documents Track wrote, the number a projection per file would be.</summary>
    public int DocumentsWritten { get; }

    /// <summary>What the recorder held once Track and the watch window behind it had settled.</summary>
    public IReadOnlyList<Notification> AfterTrack { get; }

    private readonly ModFolderWatcher _watcher;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-source-watch-game-").FullName;

    public SourceWatchRealDataFixture()
    {
        var holder = new LoadOrderHolder();
        var pluginPath = Path.Combine(ModFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        Index = new IndexProjector(holder, MutagenPluginAdapter.Instance, new DuckDbRecordIndexFactory(
            SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance), Notifications));
        Index.Reconcile(holder,
            _gameDirectory,
            [new LoadOrderEntry(CutDownPluginFixture.PluginFileName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        _watcher = TestWatcher.Over(holder, Index, Notifications, TimeSpan.FromMilliseconds(150));
        _watcher.Rearm(holder.Current);

        // The endpoint's own order: the registration upgrades the watch before Track writes.
        _watcher.WatchSourceOf(Origin);
        new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
            .TrackAsync(Index, holder, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        DocumentsWritten = Directory
            .EnumerateFiles(SourceRepository.RootIn(ModFolder, CutDownPluginFixture.PluginFileName), "*.json", SearchOption.AllDirectories)
            .Count();

        // Well past the debounce window and the projection behind it, so what the recorder holds is
        // everything Track cost.
        Thread.Sleep(2000);
        AfterTrack = Notifications.Notifications;

        // The reconcile request every tracked copy takes at load, so the rows the burst below drifts
        // from are the source tree's own.
        Index.ValidateIndex(Plugin);
    }

    // Every document that is a record's own file, in tree order: a container's own RecordData.json
    // and a level's GroupRecordData.json are neither.
    public IReadOnlyList<string> FlatDocuments() =>
        [.. Directory
            .EnumerateFiles(SourceRepository.RootIn(ModFolder, CutDownPluginFixture.PluginFileName), "*.json", SearchOption.AllDirectories)
            .Where(f => !Path.GetFileName(f).StartsWith("RecordData", StringComparison.Ordinal)
                        && !Path.GetFileName(f).StartsWith("GroupRecordData", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)];

    public void Dispose()
    {
        _watcher.Dispose();
        Index.Dispose();
        TryDelete(ModFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }
}

/// <summary>ADR-0015 invariant 2 on real data: Track and a burst wider than any batch are each one
/// projection of the plugin, and every row is right afterwards.</summary>
public sealed class SourceWatchRealDataTests(SourceWatchRealDataFixture fixture, ITestOutputHelper output)
    : IClassFixture<SourceWatchRealDataFixture>
{
    // The count a projection per file would be in the thousands; the whole tree settles as one
    // batch, so Track's own writes cost the projector one settle at most.
    [Fact]
    public void TrackingARealPlugin_CostsAtMostOneProjection_NotOnePerFile()
    {
        output.WriteLine(
            $"{fixture.DocumentsWritten} documents written ({fixture.FlatDocuments().Count} flat); " +
            $"{fixture.AfterTrack.Count} projection(s) recorded");

        Assert.True(fixture.DocumentsWritten > 32, $"only {fixture.DocumentsWritten} documents were written");
        Assert.InRange(fixture.AfterTrack.Count, 0, 1);
    }

    // Wider than one batch is worth naming keys for, so it lands as one validate of the plugin; what
    // the test asserts is the outcome, that every file's row followed.
    [Fact]
    public async Task ABurstWiderThanTheWindow_ValidatesThePlugin_AndEveryFilesRowFollows()
    {
        var documents = fixture.FlatDocuments().Where(HasAnEditorId).ToList();
        // Wider than the batch a per-key refresh would name, which is what makes this a validate.
        Assert.True(documents.Count > 32, $"only {documents.Count} documents carry an EditorID");
        var renamed = documents.ToDictionary(d => FormKeyOf(d), d => $"{EditorIdOf(d)}_ByHand", StringComparer.Ordinal);
        var before = fixture.Index.Sequence;

        foreach (var document in documents)
            File.WriteAllText(document, File.ReadAllText(document).Replace($"\"{EditorIdOf(document)}\"", $"\"{EditorIdOf(document)}_ByHand\"", StringComparison.Ordinal));

        // 60s, not 30s: under CPU contention from parallel test runs this measured 37s once, and the
        // margin below is a wait bound, not a cost this test pays every run.
        Assert.True(await fixture.Index.AwaitSequenceAsync(before + 1, TimeSpan.FromSeconds(60)));
        await WaitForEveryRow(renamed);
        foreach (var (formKey, editorId) in renamed)
            Assert.Equal(editorId, fixture.Index.Store.Require().At(RecordRef.Effective).GetDocument(formKey, fixture.Plugin)?.EditorId);
    }

    // 60s to match the sequence await above: the same load that delays the projection delays this
    // settling too, and the bound is a wait, not a per-run cost.
    private async Task WaitForEveryRow(Dictionary<string, string> renamed)
    {
        var limit = TimeSpan.FromSeconds(60);
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < limit)
        {
            if (renamed.All(r => fixture.Index.Store.Require().At(RecordRef.Effective).GetDocument(r.Key, fixture.Plugin)?.EditorId == r.Value))
                return;
            await Task.Delay(50);
        }
    }

    private static bool HasAnEditorId(string document)
    {
        using var parsed = JsonDocument.Parse(File.ReadAllText(document));
        return parsed.RootElement.TryGetProperty("EditorID", out var editorId)
               && editorId.ValueKind == JsonValueKind.String;
    }

    private static string FormKeyOf(string document) => Property(document, "FormKey");

    private static string EditorIdOf(string document) => Property(document, "EditorID");

    private static string Property(string document, string name)
    {
        using var parsed = JsonDocument.Parse(File.ReadAllText(document));
        return DocumentNodes.StringValueOf(parsed.RootElement.GetProperty(name));
    }
}
