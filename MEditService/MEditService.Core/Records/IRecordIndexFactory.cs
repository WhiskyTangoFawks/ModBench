using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public interface IRecordIndexFactory
{
    /// <summary>ADR-0001: <paramref name="instanceRoot"/> keys one persistent file per instance; an
    /// origin is a mod folder name, unique only within one. Null means an in-memory index that dies
    /// with this object.</summary>
    IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null);

    /// <summary>ADR-0046: drops the instance's index file and reopens it empty, refusing exactly as
    /// <see cref="Create"/> does when another process holds it. Floors the reopened sequence at
    /// <paramref name="atLeastSequence"/>.</summary>
    IRecordIndex Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence);
}
