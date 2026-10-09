using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>What the record index reads of tracked plugins' source trees. Each answers the folder as it
/// stands now: a mod manager can replace it wholesale.</summary>
public interface ISourceAdapter
{
    bool SourceReads(RegisteredPlugin plugin);

    bool IsTracked(RegisteredPlugin plugin);

    /// <summary>Why a tracked plugin's source does not read; null when it reads, or its mod is not tracked.</summary>
    SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin);

    /// <summary>The reads over the folder of the mod providing <paramref name="plugin"/>, tree or not; null
    /// when no mod provides it. One serves a batch, so what it learns of the tree is learned once.</summary>
    ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release);

    /// <summary>Whether <paramref name="path"/> is under <paramref name="plugin"/>'s source tree.</summary>
    bool TreeHolds(RegisteredPlugin plugin, string path);

    RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path);

    /// <summary>The name of the file of a record's own document where no tree has renamed it.</summary>
    string FileNameOf(RecordIdentity identity);
}
