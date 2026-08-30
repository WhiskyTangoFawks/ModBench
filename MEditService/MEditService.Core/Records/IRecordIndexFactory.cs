using Mutagen.Bethesda;

namespace MEditService.Core.Records;

/// <summary>#421's replacement for the deleted <c>IRecordRepositoryFactory</c>.</summary>
public interface IRecordIndexFactory
{
    /// <summary>
    /// Opens the index for one game.
    ///
    /// <para>#585 / ADR-0001: <paramref name="dataFolderPath"/> is what gives it a home — the index
    /// is one persistent file per game Data install (<see cref="IndexFile"/>), so the Data folder is
    /// its key, and a warm launch finds the rows the last one left. Omitting it asks for an index
    /// with no home at all, which is a real answer rather than a degraded one: an in-memory index
    /// that lives and dies with this object, for a caller with no install to key a file by.</para>
    /// </summary>
    IRecordIndex Create(GameRelease gameRelease, string? dataFolderPath = null);
}
