FROM python:3.12-slim

# Mount point for bind-mounted user code (read-only at runtime)
RUN mkdir /code

WORKDIR /sandbox

USER 65534

CMD ["python3"]
