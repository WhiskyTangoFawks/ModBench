using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.RealData;

/// <summary>
/// #416's own permanent gate on the compiled output — the pinned contract's "the round-trip
/// stability gate covers the compiled output" — run against the real, curated #369 fixture
/// (<see cref="CutDownPluginFixture"/>: 3,940 authentic records, populated worldspace/cell/placement,
/// four VMAD-scripted quests carrying 860 dialogue topics and 2,873 responses between them,
/// navigation meshes, landscapes).
///
/// <b>What "round trip" means for compile, and why it isn't <see cref="BinaryRoundTripGateTests"/>'s
/// original-vs-write1 shape</b>: compile's whole premise (ADR-0041) is that it builds a binary from
/// source text alone, never from an existing binary's own structure — there is no "original binary"
/// in that flow to byte-match, and container grouping details a game engine doesn't read (which
/// bucket an interior cell's GRUP sits in) have no canonical "correct" value to reproduce, only a
/// stable one. What compile promises instead, and what these tests measure:
/// <list type="bullet">
/// <item><b>Content fidelity</b>: every record's source text, deep-parsed back out of the compiled
/// binary through the exact same codec Track uses, is byte-identical to the source text Track itself
/// wrote before compile ever ran. A record's *content* survived the round trip even where its
/// container's internal bucketing did not.</item>
/// <item><b>Determinism</b> (<see cref="BinaryRoundTripGateTests"/>'s write1==write2 shape, applied
/// to this path): compiling the same source tree twice produces byte-identical binaries.</item>
/// </list>
/// </summary>
public sealed class CompileRoundTripGateTests : IDisposable
{
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-compile-roundtrip-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-compile-roundtrip-game-").FullName;
    private readonly SessionManager _sessions;
    private readonly PluginKey _plugin = new(CutDownPluginFixture.PluginFileName, "FixtureMod");

    public CompileRoundTripGateTests()
    {
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        _sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)_sessions).LoadExplicit(
            _gameDirectory,
            [new ExplicitPluginInput(CutDownPluginFixture.PluginFileName, pluginPath, _plugin.Origin!, true)],
            GameRelease.Fallout4);

        new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance)
            .TrackAsync(_sessions.Session!, _plugin.Origin!, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _sessions.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    private PluginCompileService CompileService() =>
        new(_sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    private string SourceRoot => Path.Combine(_modFolder, $"{CutDownPluginFixture.PluginFileName}{SourceRecordPath.SourceSuffix}");

    private Dictionary<string, byte[]> ReadSourceTree() =>
        Directory.EnumerateFiles(SourceRoot, "*.json", SearchOption.AllDirectories)
            .ToDictionary(f => Path.GetRelativePath(_modFolder, f), File.ReadAllBytes);

    // Deep-parses `pluginPath` and re-derives what Track would have written for every record — the
    // same codec, the same container stripping, no shortcuts — so this dict is directly comparable
    // to ReadSourceTree()'s (same relative-path keys, since SourceRecordPath.For is the one path
    // rule both Track and this call use).
    private static Dictionary<string, byte[]> DeriveSourceTreeFromBinary(string pluginPath, GameRelease release)
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var mod = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(Path.GetFileName(pluginPath)), pluginPath), release);

        var result = new Dictionary<string, byte[]>();
        foreach (var record in mod.EnumerateMajorRecords())
        {
            var recordType = ResolveRecordType(record);
            var relativePath = SourceRecordPath.For(Path.GetFileName(pluginPath), recordType, record.FormKey.ToString());
            var stripped = ContainerStripFields.StrippedForSerialization(record);
            var bytes = codec.SerializeToBytesAsync(stripped, release).GetAwaiter().GetResult();
            result[relativePath] = bytes;
        }
        return result;
    }

    private static string ResolveRecordType(IMajorRecordGetter record)
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        foreach (var (tableName, schema) in schemas)
        {
            if (schema.RecordType.IsInstanceOfType(record)) return tableName;
        }
        return record.GetType().Name.ToLowerInvariant();
    }

    [Fact]
    public void Compile_OfTheRealFixture_Succeeds()
    {
        var result = CompileService().Compile(_plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
    }

    [Fact]
    public void Compile_OfTheRealFixture_PreservesEveryRecordsSourceContent()
    {
        var before = ReadSourceTree();
        Assert.NotEmpty(before);

        var result = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        var after = DeriveSourceTreeFromBinary(pluginPath, GameRelease.Fallout4);

        Assert.Equal(before.Count, after.Count);
        foreach (var (relativePath, beforeBytes) in before)
        {
            Assert.True(after.TryGetValue(relativePath, out var afterBytes),
                $"{relativePath} exists before compile but not after.");
            Assert.True(beforeBytes.AsSpan().SequenceEqual(afterBytes),
                $"{relativePath}'s content changed across compile.");
        }
    }

    [Fact]
    public void Compile_OfTheRealFixture_IsDeterministic()
    {
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);

        var result1 = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result1.Succeeded, result1.RefusalReason);
        var write1 = File.ReadAllBytes(pluginPath);

        var result2 = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result2.Succeeded, result2.RefusalReason);
        var write2 = File.ReadAllBytes(pluginPath);

        Assert.True(write1.AsSpan().SequenceEqual(write2),
            $"Compile is not byte-stable across repeated runs: write1 {write1.Length:N0} B vs write2 {write2.Length:N0} B.");
    }
}
