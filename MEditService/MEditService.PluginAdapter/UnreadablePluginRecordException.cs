using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter;

/// <summary>A read of a plugin file's records that Mutagen cannot make, named by its diagnosis.</summary>
internal sealed class UnreadablePluginRecordException : InvalidOperationException
{
    internal UnreadablePluginRecordException(PluginDiagnosis diagnosis, Exception innerException)
        : base(diagnosis.Describe(), innerException)
    {
    }

    internal UnreadablePluginRecordException() : base("A plugin's record could not be read.")
    {
    }

    internal UnreadablePluginRecordException(string message) : base(message)
    {
    }

    internal UnreadablePluginRecordException(string message, Exception innerException) : base(message, innerException)
    {
    }
}

/// <summary>A record lookup over a plugin file whose every answer Mutagen cannot read throws
/// <see cref="UnreadablePluginRecordException"/>: Mutagen reads a record only once it is asked for.</summary>
internal sealed class DiagnosedRecordLookup(IPluginRecordLookup inner) : IPluginRecordLookup
{
    internal static T Diagnosed<T>(Func<T> read)
    {
        try
        {
            return read();
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            throw new UnreadablePluginRecordException(PluginDiagnosis.FromParseException(ex), ex);
        }
    }

    public RecordIdentity? IdentityOf(string formKey) => Diagnosed(() => inner.IdentityOf(formKey));

    public long? RecordFlagsOf(string formKey) => Diagnosed(() => inner.RecordFlagsOf(formKey));

    public string? TextOf(string formKey) => Diagnosed(() => inner.TextOf(formKey));

    public DocumentContainment? ContainmentOf(string formKey) => Diagnosed(() => inner.ContainmentOf(formKey));

    public CellStructure? CellStructureOf(string formKey) => Diagnosed(() => inner.CellStructureOf(formKey));

    public string? CellAt(string worldspace, int x, int y) => Diagnosed(() => inner.CellAt(worldspace, x, y));

    public void Dispose() => inner.Dispose();
}
