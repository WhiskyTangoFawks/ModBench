using Mutagen.Bethesda;

namespace MEditService.Core.Records;

/// <summary>#421's replacement for the deleted <c>IRecordRepositoryFactory</c>.</summary>
public interface IRecordIndexFactory
{
    /// <summary>
    /// Opens the index for one MO2 instance.
    ///
    /// <para>#592 / ADR-0001: <paramref name="instanceRoot"/> is what gives it a home — the index is
    /// one persistent file per instance (<see cref="IndexFile"/>), because <c>origin</c> is a mod
    /// folder name and so is only unique within an instance. A warm launch finds the rows the last
    /// one left. Omitting it asks for an index with no home at all, which is a real answer rather
    /// than a degraded one: an in-memory index that lives and dies with this object, for a caller
    /// with no instance to key a file by.</para>
    /// </summary>
    IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null);
}
