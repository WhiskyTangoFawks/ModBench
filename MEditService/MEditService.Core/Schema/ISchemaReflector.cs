using Mutagen.Bethesda;

namespace MEditService.Core.Schema;

public interface ISchemaReflector
{
    IReadOnlyDictionary<string, RecordTableSchema> GetSchemas(GameRelease release);

    /// <summary>
    /// Reports whether <paramref name="release"/>'s backing Mutagen record-type assembly is
    /// referenced by this build — never throws (#445). Discovery walking multiple installs should
    /// call this before <see cref="GetSchemas"/> to decide whether a release is offered at all.
    /// </summary>
    bool IsSupported(GameRelease release);
}
