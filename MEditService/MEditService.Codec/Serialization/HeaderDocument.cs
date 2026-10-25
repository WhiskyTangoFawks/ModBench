using System.IO.Abstractions;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;
using Noggog.IO;
using Noggog.WorkEngine;

namespace MEditService.Codec.Serialization;

/// <summary>The header's source document, the whole-mod door's root <c>RecordData.json</c>,
/// produced and read back through that same door without touching the disk.</summary>
public static class HeaderDocument
{

    /// <summary>The root document's exact bytes, <c>\r</c>-stripped like every committed file.</summary>
    public static byte[] Write(IModGetter mod)
    {
        var game = GameCodecs.For(mod.GameRelease);
        var folder = ScratchFolder();
        using var capture = new CaptureRootDocument(Path.Combine(folder, DocumentFileNames.Root));

        // Nothing is created and nothing is written: NoRecordFolders neutralizes the door's own
        // Directory.CreateDirectory, and every stream but the root document's goes to Stream.Null.
        InlineSerialization.Finished(
            game.SerializeWholeMod(
                game.HeaderOnly(mod), folder, InlineWorkDropoff.Instance, CancellationToken.None,
                fileSystem: NoRecordFolders.Instance, streamCreator: capture));

        // The one canonical-formatting guarantee the kernel does not make, applied identically to the
        // compiled plugin tree, so content_hash is a real git object name for the header on every platform.
        return [.. capture.Bytes().Where(b => b != (byte)'\r')];
    }

    /// <summary>The inverse, through the same door. Both a filesystem and a stream creator are
    /// required: <c>SerializationHelper.ExtractMetaInternal</c> guards on <c>File.Exists</c> before
    /// consulting the stream creator, so the creator alone fails outright.</summary>
    public static IModGetter Read(byte[] body, GameRelease release)
    {
        var folder = ScratchFolder();
        var rootPath = Path.Combine(folder, DocumentFileNames.Root);

        var mod = InlineSerialization.Finished(
            () => GameCodecs.For(release).DeserializeWholeMod(
                folder, InlineWorkDropoff.Instance, CancellationToken.None,
                fileSystem: new OnlyTheRootDocumentExists(rootPath),
                streamCreator: new SupplyRootDocument(rootPath, body)));
        return RestoreOmittedNextObjectId(mod, body);
    }

    /// <summary>Mutagen's serializer omits a Next Object ID equal to its default, which a new mod does not start at.</summary>
    public static IMod RestoreOmittedNextObjectId(IMod mod, byte[] rootDocument)
    {
        if (JsonNode.Parse(rootDocument)?[PluginHeader.ModHeaderMember]?["Stats"]?["NextFormID"] is null)
            mod.NextFormID = GameCodecs.For(mod.GameRelease).NextObjectIdDefault;
        return mod;
    }

    public static uint NextObjectId(byte[] body, GameRelease release) => Read(body, release).NextFormID;

    public static bool IsLocalized(byte[] body, GameRelease release) => Read(body, release).UsingLocalization;

    /// <summary>The document with its header's Next Object ID set to <paramref name="nextObjectId"/>.</summary>
    public static byte[] WithNextObjectId(byte[] body, GameRelease release, uint nextObjectId)
    {
        var mod = (IMod)Read(body, release);
        mod.NextFormID = nextObjectId;
        return Write(mod);
    }

    // The GUID segment: the door resolves group folders against the real filesystem, so the folder
    // must not exist; and ExtractMetaInternal prefers a ModKey parsed from the last segment, so it
    // must not look like a plugin filename.
    private static string ScratchFolder() =>
        Path.Combine(Path.GetTempPath(), $"medit-header-{Guid.NewGuid():N}");

    // Keeps the root document's bytes and sends every other record's to Stream.Null; unlike the
    // per-record codec's DiscardChildRecordStreams, this one must also answer for the root.
    private sealed class CaptureRootDocument(string rootPath) : ICreateStream, IDisposable
    {
        private readonly MemoryStream _root = new();

        public Stream GetStreamFor(IFileSystem fileSystem, FilePath path, bool write) =>
            string.Equals(path.Path, rootPath, StringComparison.Ordinal) ? _root : Stream.Null;

        /// <summary><see cref="MemoryStream.ToArray"/> is documented to work on a closed stream, so
        /// this is safe after the door has disposed it.</summary>
        public byte[] Bytes() => _root.ToArray();

        /// <summary>Only so this type does not own an undisposed stream (CA1001); the door has already
        /// disposed it, and <see cref="MemoryStream"/> tolerates the second call.</summary>
        public void Dispose() => _root.Dispose();
    }

    // The read-side counterpart: the root document from memory, an empty stream for anything else.
    private sealed class SupplyRootDocument(string rootPath, byte[] body) : ICreateStream
    {
        public Stream GetStreamFor(IFileSystem fileSystem, FilePath path, bool write) =>
            string.Equals(path.Path, rootPath, StringComparison.Ordinal)
                ? new MemoryStream(body, writable: false)
                : new MemoryStream([], writable: false);
    }

    // Answers File.Exists true for the one virtual root document so the door's existence guard
    // passes. Only Exists is overridden, so this cannot quietly disable a legitimate read elsewhere.
    private sealed class OnlyTheRootDocumentExists : FileSystem
    {
        private readonly Lazy<IFile> _file;

        public OnlyTheRootDocumentExists(string rootPath) =>
            _file = new Lazy<IFile>(() => new OnlyOnePathExists(this, rootPath));

        public override IFile File => _file.Value;

        private sealed class OnlyOnePathExists(IFileSystem fileSystem, string rootPath) : FileWrapper(fileSystem)
        {
            public override bool Exists(string? path) => string.Equals(path, rootPath, StringComparison.Ordinal);
        }
    }
}
