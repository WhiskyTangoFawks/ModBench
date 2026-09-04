using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

/// <summary>Both ingest paths call the same <see cref="IRecordIndex.Index"/> over the same mod shape, so
/// there is no second extraction to drift; this checks it on 3,940 authentic records.</summary>
public sealed class SourceIngestParityTests : IDisposable
{
    private const string Origin = "FixtureMod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-source-parity-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-source-parity-game-").FullName;
    private readonly LoadOrderMirror _fromBinary;
    private readonly LoadOrderMirror _fromSource;
    private readonly PluginKey _plugin = new(CutDownPluginFixture.PluginFileName, Origin);

    public SourceIngestParityTests()
    {
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        // Untracked at this point, so this load order is the ordinary binary-overlay ingest — the
        // "untracked copy" half of AC3, and the reference every assertion below compares against.
        _fromBinary = NewLoadOrder(pluginPath);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_fromBinary.LoadOrder!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        // Same folder, same plugin file, same origin — the only difference is that it is now tracked,
        // so this load order ingests from the source tree Track just wrote.
        _fromSource = NewLoadOrder(pluginPath);
    }

    private LoadOrderMirror NewLoadOrder(string pluginPath)
    {
        var mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)mirror).Reconcile(
            _gameDirectory,
            [new LoadOrderEntry(CutDownPluginFixture.PluginFileName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        return mirror;
    }

    public void Dispose()
    {
        _fromSource.Dispose();
        _fromBinary.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    [Fact]
    public void TheTrackedPluginReallyIngestedFromSource_NotViaTheBinaryFallback()
    {
        Assert.Empty(_fromSource.Status.Failures);
        Assert.NotNull(SourceIngest.TreeFor(Origin, Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginFileName));
    }

    [Fact]
    public void TheSameRecordsExist_TrackedAndUntracked()
    {
        var binary = AllFormKeys(_fromBinary).ToHashSet(StringComparer.Ordinal);
        var source = AllFormKeys(_fromSource).ToHashSet(StringComparer.Ordinal);

        // The fixture is real data with real containers; an empty or tiny set here would make every
        // other assertion in this file vacuous.
        Assert.True(binary.Count > 2000, $"fixture looks wrong: only {binary.Count} records");
        Assert.Equal(binary.Count, source.Count);
        Assert.Empty(binary.Except(source, StringComparer.Ordinal));
        Assert.Empty(source.Except(binary, StringComparer.Ordinal));
    }

    [Fact]
    public void EveryEmbeddedChildRecord_IsItsOwnQueryableRecord_OnBothPaths()
    {
        var embeddedTypes = new[] { "refr", "achr", "navm", "land", "cell", "pgre", "pmis", "phzd" };

        foreach (var type in embeddedTypes)
        {
            var binary = CountOf(_fromBinary, type);
            if (binary == 0) continue;

            Assert.Equal(binary, CountOf(_fromSource, type));
        }

        // Positive control: the fixture must really hold embedded children, or the loop above is a
        // walk over an empty set that would pass for a plugin with no containers at all.
        Assert.True(CountOf(_fromBinary, "refr") > 0, "fixture holds no placed references");
        Assert.True(CountOf(_fromBinary, "cell") > 0, "fixture holds no cells");
    }

    private List<string> AllFormKeys(LoadOrderMirror mirror) =>
        [.. mirror.Index!.At(RecordRef.Effective).Search(new RecordQuery(Plugin: _plugin, Limit: int.MaxValue)).Items.Select(i => i.FormKey)];

    private int CountOf(LoadOrderMirror mirror, string recordType) =>
        mirror.Index!.At(RecordRef.Effective).GetRecordTypeCounts(_plugin).FirstOrDefault(c => c.Type == recordType)?.Count ?? 0;

    [Fact]
    public void EveryRecordsDocument_IsByteIdentical_ExceptTheOneKnown369OverlayVsDeepParseCell()
    {
        var mismatched = new List<string>();
        var byType = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var formKey in AllFormKeys(_fromBinary))
        {
            var binary = _fromBinary.Index!.At(RecordRef.Effective).GetDocument(formKey, _plugin);
            var source = _fromSource.Index!.At(RecordRef.Effective).GetDocument(formKey, _plugin);
            if (binary?.Body == source?.Body) continue;
            mismatched.Add(formKey);
            var type = binary?.RecordType ?? source?.RecordType ?? "?";
            byType[type] = byType.GetValueOrDefault(type) + 1;
        }

        var byTypeText = string.Join(", ", byType.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key}={kv.Value}"));

        // Pinned count and type. The fixture is hermetic and checked in, so any drift here is signal.
        Assert.True(mismatched.Count == 1, $"expected exactly the one known #369 divergence; got {mismatched.Count} ({byTypeText})");
        Assert.Equal("cell=1", byTypeText);

        // ...and pinned to the *field*, so another Cell field starting to diverge cannot hide behind
        // the same count.
        var binaryBody = _fromBinary.Index!.At(RecordRef.Effective).GetDocument(mismatched[0], _plugin)!.Body!;
        var sourceBody = _fromSource.Index!.At(RecordRef.Effective).GetDocument(mismatched[0], _plugin)!.Body!;
        Assert.Contains("\"Break2\"", binaryBody, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Break2\"", sourceBody, StringComparison.Ordinal);
        Assert.Equal(
            StripVersioningBlock(binaryBody),
            StripVersioningBlock(sourceBody));
    }

    [Fact]
    public void TheHeaderRow_IsByteIdentical_TrackedAndUntracked()
    {
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(CutDownPluginFixture.PluginFileName));

        var binary = _fromBinary.Index!.At(RecordRef.Effective).GetDocument(headerFormKey, _plugin);
        var source = _fromSource.Index!.At(RecordRef.Effective).GetDocument(headerFormKey, _plugin);

        Assert.NotNull(binary);
        Assert.NotNull(source);
        Assert.Equal(HeaderIndexer.RecordType, binary.RecordType);
        Assert.Equal(HeaderIndexer.RecordType, source.RecordType);

        // Positive controls: an empty or absent body would satisfy plain equality below and prove
        // nothing at all. These pin that the body really is the root document.
        Assert.NotNull(binary.Body);
        Assert.Contains("\"ModHeader\"", binary.Body, StringComparison.Ordinal);
        Assert.Contains("\"MasterReferences\"", binary.Body, StringComparison.Ordinal);

        Assert.Equal(binary.Body, source.Body);
        Assert.Equal(ContentHashOf(_fromBinary, headerFormKey), ContentHashOf(_fromSource, headerFormKey));

        // The third arm: against the tracked plugin's own file on disk, as raw bytes. `records.body`
        // is VARCHAR, so this is the only comparison here that is genuinely about bytes.
        var headerFile = Path.Combine(_modFolder, "source", CutDownPluginFixture.PluginFileName, "RecordData.json");
        Assert.True(File.Exists(headerFile), $"expected the tracked tree to hold {headerFile}");
        Assert.Equal(File.ReadAllBytes(headerFile), Encoding.UTF8.GetBytes(source.Body!));
    }

    private static string ContentHashOf(LoadOrderMirror mirror, string formKey)
    {
        using var cmd = ((DuckDbRecordIndex)mirror.Index!).Connection.CreateCommand();
        cmd.CommandText = "SELECT content_hash FROM records WHERE form_key = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        return Assert.IsType<string>(cmd.ExecuteScalar());
    }

    private static string StripVersioningBlock(string body) =>
        System.Text.RegularExpressions.Regex.Replace(
            body, "\"Versioning\": \\[[^\\]]*\\]", "\"Versioning\": []");

    [Fact]
    public void PlacementAndCellLocationRows_AreIdentical_TrackedAndUntracked()
    {
        var placed = 0;
        var located = 0;

        foreach (var formKey in AllFormKeys(_fromBinary))
        {
            var binaryPlacement = _fromBinary.Index!.At(RecordRef.Effective).GetPlacement(formKey, _plugin);
            var sourcePlacement = _fromSource.Index!.At(RecordRef.Effective).GetPlacement(formKey, _plugin);
            Assert.Equal(binaryPlacement, sourcePlacement);
            if (binaryPlacement != null) placed++;

            var binaryLocation = _fromBinary.Index!.At(RecordRef.Effective).GetCellLocation(_plugin, formKey);
            var sourceLocation = _fromSource.Index!.At(RecordRef.Effective).GetCellLocation(_plugin, formKey);
            Assert.Equal(binaryLocation, sourceLocation);
            if (binaryLocation != null) located++;
        }

        // Positive controls: an all-null comparison is trivially equal on both sides.
        Assert.True(placed > 0, "fixture produced no placement rows");
        Assert.True(located > 0, "fixture produced no cell_location rows");
    }

    [Fact]
    public void FormLookupAndReferenceRows_AreIdentical_TrackedAndUntracked()
    {
        var referenced = 0;

        foreach (var formKey in AllFormKeys(_fromBinary))
        {
            Assert.Equal(_fromBinary.Index!.At(RecordRef.Effective).Resolve(formKey), _fromSource.Index!.At(RecordRef.Effective).Resolve(formKey));

            var binaryRefs = _fromBinary.Index!.At(RecordRef.Effective).GetReferencedBy(formKey).OrderBy(r => r.ToString(), StringComparer.Ordinal).ToList();
            var sourceRefs = _fromSource.Index!.At(RecordRef.Effective).GetReferencedBy(formKey).OrderBy(r => r.ToString(), StringComparer.Ordinal).ToList();
            referenced += binaryRefs.Count;

            // Hard, and exact: no reference may appear, disappear, or move within its own FieldPath's
            // array ordinal.
            Assert.True(binaryRefs.SequenceEqual(sourceRefs),
                $"form_references differs for {formKey}: binary=[{string.Join(", ", binaryRefs)}], " +
                $"source=[{string.Join(", ", sourceRefs)}]");
        }

        Assert.True(referenced > 0, "fixture produced no form_references rows");
    }

    [Fact]
    public void ContainerChildRows_AreIdentical_TrackedAndUntracked()
    {
        var children = 0;

        foreach (var formKey in AllFormKeys(_fromBinary))
        {
            var binary = _fromBinary.Index!.At(RecordRef.Effective).GetContainerChildren(_plugin, formKey);
            var source = _fromSource.Index!.At(RecordRef.Effective).GetContainerChildren(_plugin, formKey);
            children += binary.Count;

            // Hard, and exact: the containment graph may not move, and neither may a child's slot
            // order within it — no allowlist for either kind of divergence.
            Assert.True(binary.SequenceEqual(source),
                $"container_child differs for {formKey}: binary=[{string.Join(", ", binary)}], " +
                $"source=[{string.Join(", ", source)}]");
        }

        Assert.True(children > 0, "fixture produced no container_child rows");
    }
}
