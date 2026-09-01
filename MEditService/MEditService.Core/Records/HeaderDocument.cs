using System.IO.Abstractions;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;
using Noggog.IO;
using Noggog.WorkEngine;

namespace MEditService.Core.Records;

/// <summary>
/// The plugin header's own source document — the whole-mod door's root <c>RecordData.json</c> —
/// produced from a mod and read back into one, without ever touching the disk.
///
/// <para><b>Why this exists at all.</b> ADR-0041 names the root <c>RecordData.json</c> as part of a
/// plugin's source ("Source is complete… including the mod header (root <c>RecordData.json</c>)"), so
/// the header's body is that file's own bytes and nothing else. A <see cref="ModHeader"/> is not an
/// <see cref="IMajorRecordGetter"/>, so <see cref="Serialization.RecordTextCodec"/> — which is
/// per-record and stays per-record — structurally cannot produce or consume it. This is the header's
/// half of the same one-document-shape promise, and it is deliberately written in terms of the *same*
/// door rather than a second implementation of its dialect: hand-rolling the
/// <c>{ModKey, GameRelease, ModHeader}</c> wrapper would be exactly the drift the whole-mod-door
/// whitelist exists to prevent.</para>
///
/// <para><b>One producer, not two.</b> A tracked plugin and an untracked one both reach
/// <see cref="Write"/> with an <see cref="IModGetter"/> — tree-deserialized for the first, binary
/// overlay for the second — the identical shape every other record already goes through
/// (<c>PluginIngest.PrepareRecord</c> re-serializes from the getter ingest holds; <c>SourceIngest</c>
/// deserializes the tree and hands the result to the same <c>Index</c>). So "the two body sources
/// speak one dialect" is not a coincidence to be tested for, it is one code path; what
/// <c>SourceIngestParityTests</c> then proves is the remaining, real question — that the two
/// <i>readers</i> (deep parse behind the tree, binary overlay) present the same header.</para>
///
/// <para><b>This is a designated door</b> for the generated whole-mod mixin — only the designated
/// doors may call it; <see cref="Serialization.RecordTextCodecGeneratorSeedTests"/> enforces the
/// whitelist.</para>
/// </summary>
internal static class HeaderDocument
{
    /// <summary>The whole-mod door's own name for the root document
    /// (<c>SerializationHelper.RecordDataFileNameWithoutExtension</c> plus the JSON kernel's
    /// extension). Same literal as <c>SourceUnitResolver.RecordDataFileName</c>, which names it for
    /// the container-per-record case; kept separate rather than shared because the two are answering
    /// different questions and neither owns the other's.</summary>
    private const string RootDocumentFileName = "RecordData.json";

    /// <summary>
    /// The mod header's document bytes: exactly what the whole-mod door writes as the tree's root
    /// <c>RecordData.json</c>, canonicalized the same way <c>TrackService.SerializeToPristineFiles</c>
    /// canonicalizes every file it commits (no <c>\r</c>, no trailing newline).
    ///
    /// <para><b>Serialized from a header-only clone, not from <paramref name="mod"/> itself, and that
    /// is a measured choice.</b> The door writes the root document from the mod-level serializer,
    /// which walks every group whether or not anything consumes the child streams — measured at
    /// <b>1,510 ms cold / 239 ms warm</b> per plugin over the 3,940-record cut-down fixture, which on a
    /// real load order is minutes rather than noise. An empty mod carrying only a deep copy of the
    /// header produces the <i>byte-identical</i> root document in <b>1 ms</b>, because the root
    /// document holds only <c>ModKey</c>, <c>GameRelease</c> and <c>ModHeader</c> — the groups
    /// contribute nothing to it. <c>HeaderDocumentTests</c> pins that equality directly against a
    /// full walk, so a Mutagen/Serialization bump that changed either the root document's shape or
    /// <c>DeepCopyIn</c>'s completeness goes red here rather than silently shipping a lossy header.</para>
    /// </summary>
    internal static byte[] Write(IModGetter mod)
    {
        // FO4-typed for the same reason TrackService's own whole-mod call is: the generated mixin is
        // itself seeded from an FO4 mod type, so this is the existing generalization boundary rather
        // than a new one (root CLAUDE.md's game-generalization rule is about mechanisms this codebase
        // owns; the door's seed shape is the library's).
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

        // The one canonical-formatting guarantee the kernel does not make, applied identically to
        // RecordTextCodec.SerializeCoreAsync's own \r-strip and TrackService's for the committed
        // tree — so this document's bytes and the tracked file's bytes are the same bytes on every
        // platform, which is what makes content_hash a real git object name for the header too.
        return [.. capture.Bytes().Where(b => b != (byte)'\r')];
    }

    /// <summary>
    /// The inverse: a header document's bytes back into a mod whose <c>ModHeader</c> carries the
    /// document's own values — read through the <b>same door</b>, so there is no second reader of this
    /// dialect either. Every group is empty (nothing on the virtual filesystem answers for one), which
    /// is exactly right: this document describes the header and nothing else.
    ///
    /// <para><b>Both a filesystem and a stream creator are required, and the reason is upstream.</b>
    /// <c>SerializationHelper.ExtractMetaInternal</c> guards on <c>fileSystem.File.Exists(path)</c>
    /// <i>before</i> consulting the stream creator, throwing
    /// <c>FileNotFoundException("Could not find file to parse")</c> when it answers false. Supplying
    /// the stream creator alone therefore fails outright — verified by trying exactly that, not
    /// assumed.</para>
    /// </summary>
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

    /// <summary>
    /// An absolute path that certainly does not exist, per call.
    ///
    /// <para><b>The GUID segment is load-bearing twice.</b> The door resolves group folders against the
    /// <i>real</i> filesystem (only <c>File.Exists</c> is virtualized below), so the folder must not
    /// exist or a stray directory would be read as this mod's groups. And
    /// <c>SerializationHelper.ExtractMetaInternal</c> prefers a ModKey parsed from the folder's own
    /// last segment over the one written in the document — so the segment must not look like a plugin
    /// filename either. A GUID satisfies both; a fixed name like <c>"header"</c> satisfies only the
    /// second.</para>
    /// </summary>
    private static string ScratchFolder() =>
        Path.Combine(Path.GetTempPath(), $"medit-header-{Guid.NewGuid():N}");

    /// <summary>Keeps the root document's bytes and sends every folder-split child's nowhere — the
    /// same shape, and the same reasoning, as <c>RecordTextCodec</c>'s own
    /// <c>DiscardChildRecordStreams</c>, except that this one also has to answer for the root document
    /// itself (which that codec never writes, since a single record has no root).</summary>
    private sealed class CaptureRootDocument(string rootPath) : ICreateStream, IDisposable
    {
        private readonly MemoryStream _root = new();

        public Stream GetStreamFor(IFileSystem fileSystem, FilePath path, bool write) =>
            string.Equals(path.Path, rootPath, StringComparison.Ordinal) ? _root : Stream.Null;

        /// <summary>Safe after the door has disposed the stream — which it does, since it takes it in
        /// a <c>using</c>: <see cref="MemoryStream.ToArray"/> is documented to work on a closed
        /// stream, which is what lets the door own the lifetime and this class still answer for the
        /// bytes afterwards.</summary>
        public byte[] Bytes() => _root.ToArray();

        /// <summary>Only so this type does not own an undisposed stream (CA1001). The door has
        /// already disposed <see cref="_root"/> by the time this runs; <see cref="MemoryStream"/>
        /// tolerates the second call, and <see cref="Bytes"/> keeps working after both.</summary>
        public void Dispose() => _root.Dispose();
    }

    /// <summary>The read-side mirror: the root document's bytes from memory, and an empty stream for
    /// anything else the door asks for.</summary>
    private sealed class SupplyRootDocument(string rootPath, byte[] body) : ICreateStream
    {
        public Stream GetStreamFor(IFileSystem fileSystem, FilePath path, bool write) =>
            string.Equals(path.Path, rootPath, StringComparison.Ordinal)
                ? new MemoryStream(body, writable: false)
                : new MemoryStream([], writable: false);
    }

    /// <summary>
    /// A real filesystem that answers <c>File.Exists</c> true for the one virtual root document and
    /// false for everything else, so the door's existence guard passes without a file on disk.
    /// Deliberately only <see cref="IFile.Exists(string?)"/> is overridden — every other operation
    /// behaves normally, so this cannot quietly disable a legitimate read elsewhere, the same scoping
    /// rule <c>RecordTextCodec.NoRecordFolders</c> already states for its own override.
    /// </summary>
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

    /// <summary>
    /// The write side's other half: the door creates its target directory (and, under
    /// <c>.FilePerRecord()</c>, a folder per folder-split container) directly through
    /// <c>SerializationMetaData.FileSystem</c> rather than through the stream creator, so redirecting
    /// streams alone still leaves directories on disk. Same class, same reasoning and same narrow
    /// scope as <c>RecordTextCodec</c>'s own copy; kept separate because that one is private to the
    /// per-record codec and this door must not reach into it.
    /// </summary>
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
