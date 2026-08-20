using Mutagen.Bethesda;

namespace MEditService.Core.Records;

/// <summary>#421's replacement for <c>IRecordRepositoryFactory</c> — additive alongside it during
/// the migration; <c>DuckDbRecordIndexFactory</c> implements both until the old interface is
/// demolished.</summary>
public interface IRecordIndexFactory
{
    IRecordIndex Create(GameRelease gameRelease);
}
