namespace MEditService.RecordIndex;

/// <summary>What the record index's database refused, in the index's own words.</summary>
internal enum IndexFault
{
    /// <summary>The statement was refused for any other reason: its syntax, a name it uses, a constraint, a file, an interrupt.</summary>
    Refused,
    /// <summary>A value a row holds could not be converted, was out of range or was invalid input.</summary>
    RowValue,
    OutOfMemory,
    /// <summary>A fatal error, a failed checkpoint among them, invalidated the database; it answers nothing until its file is opened again.</summary>
    Invalidated,
}

internal sealed class IndexFaultException : InvalidOperationException
{
    internal IndexFaultException()
    {
    }

    internal IndexFaultException(string message) : base(message)
    {
    }

    internal IndexFaultException(string message, Exception innerException) : base(message, innerException)
    {
    }

    public IndexFault Fault { get; init; }
}
