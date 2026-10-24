using System.Buffers.Binary;
using System.Collections;
using System.Diagnostics.CodeAnalysis;
using System.IO.Compression;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using static MEditService.TestSupport.RawPlugin;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginReadabilityTests : IDisposable
{
    private const string PluginName = "Readable.esp";

    private readonly PluginFixtureData _data = new PluginFixtureBuilder("adapter-readability")
        .WithPlugin(PluginName, mod => mod.Npcs.AddNew("Npc"))
        .Build();

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private string PluginPath => Path.Combine(_data.DataFolder, PluginName);

    public void Dispose() => _data.Dispose();

    private static Task<Answer<PluginSource, PluginFailure>> ReadSourceAt(string path) =>
        Adapter.ReadSourceOfAsync(
            new RegisteredPlugin(Path.GetFileName(path), PluginOrigin.DataDirectory, path, PluginProvider.Game, Line: null, HandedStrings.Of(path)),
            EmptyLoadOrder.Of(GameRelease.Fallout4));

    [Fact]
    public async Task APluginThatIsNotThere_IsInaccessible() =>
        Assert.IsType<PluginFailure.Inaccessible>((await ReadSourceAt(Path.Combine(_data.DataFolder, "Absent.esp"))).Failure());

    [Fact]
    public void TheContentOfAPluginThatIsNotThere_IsInaccessible()
    {
        var path = Path.Combine(_data.DataFolder, "Absent.esp");

        var read = Adapter.ReadContent(new ModPath(ModKey.FromFileName("Absent.esp"), path), EmptyLoadOrder.Of(GameRelease.Fallout4), PluginStrings.None);

        Assert.IsType<PluginFailure.Inaccessible>(read.Failure());
    }

    [Fact]
    public async Task AnEmptyFile_OpensAndIsUnparsed()
    {
        var path = Path.Combine(_data.DataFolder, "Empty.esp");
        File.WriteAllBytes(path, []);

        Assert.IsType<PluginFailure.Unparsed>((await ReadSourceAt(path)).Failure());
    }

    [Fact]
    public async Task APluginAnotherHandleHoldsAgainstSharing_IsInaccessible_UntilThatHandleCloses()
    {
        using (new FileStream(PluginPath, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            Assert.IsType<PluginFailure.Inaccessible>((await ReadSourceAt(PluginPath)).Failure());
        }

        Assert.NotEmpty((await ReadSourceAt(PluginPath)).Answered().Files);
    }

    [Fact]
    public async Task ADirectoryAtThePluginsPath_IsInaccessible()
    {
        var path = Path.Combine(_data.DataFolder, "Folder.esp");
        Directory.CreateDirectory(path);

        Assert.IsType<PluginFailure.Inaccessible>((await ReadSourceAt(path)).Failure());
    }

    private const string UninflatablePlugin = "Uninflatable.esp";

    private string WithARecordDeclaringALengthItsBytesCannotInflateTo()
    {
        const int MoreThanAnArrayHolds = 0x7FFFFFD0;
        var npc = DeflatedRecord("NPC_", 0x800, CompressionLevel.Optimal, EditorId("Npc"));
        BinaryPrimitives.WriteInt32LittleEndian(npc.AsSpan(24), MoreThanAnArrayHolds);
        var path = Path.Combine(_data.DataFolder, UninflatablePlugin);
        File.WriteAllBytes(path, Plugin(Tes4(), Group("NPC_", npc)));
        return path;
    }

    [Fact]
    public void TheDocumentsOfAPluginWhoseRecordCannotInflate_CarryItAsTheTypesFailure()
    {
        var path = WithARecordDeclaringALengthItsBytesCannotInflateTo();

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(UninflatablePlugin), path), EmptyLoadOrder.Of(GameRelease.Fallout4),
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4), PluginStrings.None).Answered();

        Assert.Empty(documents.Records);
        Assert.Equal("npc_", Assert.Single(documents.Failures).RecordType);
    }

    [Fact]
    public async Task TheSourceOfAPluginWhoseRecordCannotInflate_IsUnparsed() =>
        Assert.IsType<PluginFailure.Unparsed>((await ReadSourceAt(WithARecordDeclaringALengthItsBytesCannotInflateTo())).Failure());

    [Fact]
    public void ARecordReadStoppedByRunningOutOfMemory_ThrowsThatCause_HoweverItIsWrapped()
    {
        using var records = Adapter.OpenRecordLookup(
            new RegisteredPlugin(PluginName, PluginOrigin.DataDirectory, PluginPath, PluginProvider.Game, Line: null, PluginStrings.None),
            EmptyLoadOrder.Of(GameRelease.Fallout4), new SchemasWhoseReadRunsOutOfMemory()).Answered();

        Assert.Throws<OutOfMemoryException>(() => records.TextOf($"000800:{PluginName}"));
    }

    private sealed class SchemasWhoseReadRunsOutOfMemory : IReadOnlyDictionary<string, RecordTableSchema>
    {
        private static InvalidOperationException Wrapped() =>
            new("a wrapper", Activator.CreateInstance<OutOfMemoryException>());

        public RecordTableSchema this[string key] => throw Wrapped();

        public IEnumerable<string> Keys => throw Wrapped();

        public IEnumerable<RecordTableSchema> Values => throw Wrapped();

        public int Count => throw Wrapped();

        public bool ContainsKey(string key) => throw Wrapped();

        public bool TryGetValue(string key, [MaybeNullWhen(false)] out RecordTableSchema value) => throw Wrapped();

        public IEnumerator<KeyValuePair<string, RecordTableSchema>> GetEnumerator() => throw Wrapped();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
