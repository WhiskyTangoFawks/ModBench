using Mutagen.Bethesda;

namespace MEditService.Core.Records;

/// <summary>#421's replacement for the deleted <c>IRecordRepositoryFactory</c>.</summary>
public interface IRecordIndexFactory
{
    IRecordIndex Create(GameRelease gameRelease);
}
