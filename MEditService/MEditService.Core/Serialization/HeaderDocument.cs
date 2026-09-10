using System.IO.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;
using Noggog.IO;
using Noggog.WorkEngine;

namespace MEditService.Core.Serialization;

/// <summary>The header's source document — the whole-mod door's root <c>RecordData.json</c>
/// (ADR-0041) — produced and read back through that same door, never a second implementation of
/// its dialect, without touching the disk.</summary>
internal static class HeaderDocument
{
    // Same literal as SourceRepository.RecordDataFileName; kept separate because the two answer
    // different questions and neither owns the other's.
    private const string RootDocumentFileName = "RecordData.json";

    /// <summary>The root document's exact bytes, <c>\r</c>-stripped like every committed file.
    /// Serialized from a header-only clone: a full-mod walk costs ~1.5 s per plugin, the clone 1 ms,
    /// byte-identical.</summary>
    internal static byte[] Write(IModGetter mod)
    {
        // FO4-typed for the same reason TrackService's whole-mod call is: the generated mixin is
        // seeded from an FO4 mod type, so this is the existing generalization boundary, not a new one.
        var source = (IFallout4ModGetter)mod;
        var clone = new Fallout4Mod(source.ModKey, source.GameRelease.ToFallout4Release());
        clone.ModHeader.DeepCopyIn(source.ModHeader);

        var folder = ScratchFolder();
        using var capture = new CaptureRootDocument(Path.Combine(folder, RootDocumentFileName));

        // Nothing is created and nothing is written: NoRecordFolders neutralizes the door's own
        // Directory.CreateDirectory, and every stream but the root document's goes to Stream.Null.
        RecordTextCodecGeneratorSeed.SerializeWholeMod(
            clone, folder, InlineWorkDropoff.Instance, CancellationToken.None,
            fileSystem: NoRecordFolders.Instance, streamCreator: capture)
            .GetAwaiter().GetResult();

        // The one canonical-formatting guarantee the kernel does not make, applied identically to the
        // tracked tree, so content_hash is a real git object name for the header on every platform.
        return [.. capture.Bytes().Where(b => b != (byte)'\r')];
    }

    /// <summary>The inverse, through the same door. Both a filesystem and a stream creator are
    /// required: <c>SerializationHelper.ExtractMetaInternal</c> guards on <c>File.Exists</c> before
    /// consulting the stream creator, so the creator alone fails outright.</summary>
    internal static IModGetter Read(byte[] body)
    {
        var folder = ScratchFolder();
        var rootPath = Path.Combine(folder, RootDocumentFileName);

        return RecordTextCodecGeneratorSeed.DeserializeWholeMod(
            folder, InlineWorkDropoff.Instance, CancellationToken.None,
            fileSystem: new OnlyTheRootDocumentExists(rootPath),
            streamCreator: new SupplyRootDocument(rootPath, body))
            .GetAwaiter().GetResult();
    }

    /// <summary>The document with the ESL (<c>Small</c>) flag set or cleared, as a document-to-document
    /// transform through the same two doors so no third dialect of the header exists.</summary>
    internal static byte[] WithLightFlag(byte[] body, bool isLight)
    {
        var source = (IFallout4ModGetter)Read(body);
        var clone = new Fallout4Mod(source.ModKey, source.GameRelease.ToFallout4Release());
        clone.ModHeader.DeepCopyIn(source.ModHeader);
        clone.IsSmallMaster = isLight;
        return Write(clone);
    }

    /// <summary>Whether the document's header carries the ESL flag — read through <see cref="Read"/>,
    /// never string-matched out of the JSON, so the answer is the door's own.</summary>
    internal static bool IsLight(byte[] body) => Read(body) is IModFlagsGetter flags && flags.IsSmallMaster;

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

    // The door creates its target directory through SerializationMetaData.FileSystem rather than the
    // stream creator, so redirecting streams alone still leaves directories on disk. A copy of
    // RecordTextCodec's, which is private to that codec.
    private sealed class NoRecordFolders : FileSystem
    {
        internal static readonly NoRecordFolders Instance = new();

        private readonly Lazy<IDirectory> _directory;

        private NoRecordFolders() => _directory = new Lazy<IDirectory>(() => new NonCreatingDirectory(this));

        public override IDirectory Directory => _directory.Value;

        private sealed class NonCreatingDirectory(IFileSystem fileSystem) : DirectoryWrapper(fileSystem)
        {
            public override IDirectoryInfo CreateDirectory(string path) => FileSystem.DirectoryInfo.New(path);
        }
    }
}
