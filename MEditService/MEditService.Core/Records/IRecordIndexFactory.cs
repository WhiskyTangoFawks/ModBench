using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public interface IRecordIndexFactory
{
    /// <summary>ADR-0001: <paramref name="instanceRoot"/> keys one persistent file per instance; an
    /// origin is a mod folder name, unique only within one. Null means an in-memory index that dies
    /// with this object.</summary>
    IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null);
}
